import { memo, useEffect, useSyncExternalStore } from "react";
import "./syntax.css";

// Highlighted code for the transcript: a Markdown fence, a tool call's arguments, a file a tool read. The highlighter
// (languages.ts) loads as its own chunk the first time any code asks for it; until then code shows as plain text in the
// theme's code colour, then every block on the page highlights in the one render that follows. Colours are never in
// the markup: highlighting writes `hljs-*` classes and syntax.css maps them onto the theme's --hb-syntax-* tokens, so
// switching theme restyles every block without highlighting anything again.

type Highlighter = (code: string, language: string) => string | undefined;

let highlighter: Highlighter | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

/** Loads the highlighter once. Resolves when it is ready (also when it failed to load: code then stays plain). */
export function loadHighlighter(): Promise<void> {
	loading ??= import("./languages.ts").then(
		(module) => {
			highlighter = module.highlightHtml;
			for (const listener of listeners) listener();
		},
		() => {},
	);
	return loading;
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
const ready = () => highlighter !== undefined;

/** Past this, code shows plain: highlighting a long log costs more than it gives. */
export const HIGHLIGHT_LIMIT = 60_000;

/** Highlighted HTML for `code`, once the highlighter has loaded and when it knows the language; else undefined. */
export function highlightCode(code: string, language: string | undefined): string | undefined {
	if (language === undefined || highlighter === undefined || code.length > HIGHLIGHT_LIMIT) return undefined;
	try {
		return highlighter(code, language.toLowerCase());
	} catch {
		return undefined;
	}
}

const extensions: Readonly<Record<string, string>> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	jsonc: "json",
	jsonl: "json",
	md: "markdown",
	mdx: "markdown",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	css: "css",
	scss: "css",
	html: "xml",
	htm: "xml",
	xml: "xml",
	svg: "xml",
	yml: "yaml",
	yaml: "yaml",
	toml: "ini",
	ini: "ini",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	sql: "sql",
	diff: "diff",
	patch: "diff",
};

/** The language to highlight a file in, by its name: `src/app.tsx` is TypeScript. Undefined for anything else. */
export function languageForPath(path: string): string | undefined {
	const name = path.split("/").pop() ?? "";
	if (name === "Dockerfile" || name.endsWith(".dockerfile")) return "dockerfile";
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? undefined : extensions[name.slice(dot + 1).toLowerCase()];
}

/**
 * Code in a theme's syntax colours. Renders a `<code>`; the host puts it in its own `<pre>` and styles that. Plain text
 * until the highlighter has loaded, or when the language is unknown or missing.
 */
export const Code = memo(function Code({
	code,
	language,
	className,
}: {
	code: string;
	language: string | undefined;
	className?: string | undefined;
}) {
	const loaded = useSyncExternalStore(subscribe, ready, ready);
	useEffect(() => {
		if (language !== undefined && !loaded) void loadHighlighter();
	}, [language, loaded]);
	const html = loaded ? highlightCode(code, language) : undefined;
	const classes = `hb-syntax${className === undefined ? "" : ` ${className}`}`;
	// The highlighter escapes the code it is given: its output is spans of escaped text.
	// biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output, escaped text in class-only spans.
	if (html !== undefined) return <code className={classes} dangerouslySetInnerHTML={{ __html: html }} />;
	return <code className={classes}>{code}</code>;
});
