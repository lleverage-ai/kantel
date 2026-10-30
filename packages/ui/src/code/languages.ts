// The highlighter itself: highlight.js's core with the languages agents write most, loaded as one chunk the first time
// a code block asks for it (code.ts), so a page with no code pays nothing for it. Its output is spans with `hljs-*`
// classes and no colours of their own; syntax.css colours them from the theme's --hb-syntax-* tokens.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const languages = {
	bash,
	c,
	cpp,
	css,
	diff,
	dockerfile,
	go,
	ini,
	java,
	javascript,
	json,
	markdown,
	python,
	ruby,
	rust,
	shell,
	sql,
	typescript,
	xml,
	yaml,
};
for (const [name, language] of Object.entries(languages)) hljs.registerLanguage(name, language);
hljs.registerAliases(["tsx", "mts", "cts"], { languageName: "typescript" });
hljs.registerAliases(["jsonc", "json5", "jsonl"], { languageName: "json" });
hljs.registerAliases(["toml", "conf", "env"], { languageName: "ini" });

/** Highlighted HTML for `code`, or undefined when the language isn't one it knows. */
export function highlightHtml(code: string, language: string): string | undefined {
	if (hljs.getLanguage(language) === undefined) return undefined;
	return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}
