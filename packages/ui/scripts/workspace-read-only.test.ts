import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The workspace components and the file preview are presentational: the host reads the workspace through its read
// API and passes them what it read. This keeps them that way. They import only React and the library's own modules, never a client,
// a contract package or anything that could reach a sandbox, and they make no requests of their own.

/** Source without its comments, which may name what the code must not use. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sourcesIn = (path: string) => {
	const dir = new URL(path, import.meta.url);
	return readdirSync(dir)
		.filter((name) => /\.tsx?$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name) && name !== "fixtures.ts")
		.map((name) => ({ name, text: code(readFileSync(new URL(name, dir), "utf8")) }));
};
const sources = sourcesIn("../src/workspace/");
const previews = [...sourcesIn("../src/preview/"), ...sourcesIn("../src/preview/bodies/")];

const specifiers = (text: string) =>
	[...text.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s+"([^"]+)"/g)].map((m) => m[1] ?? m[2]);

describe("the workspace components", () => {
	it("are all checked", () => {
		expect(sources.map((source) => source.name)).toEqual(
			expect.arrayContaining(["file-tree.tsx", "workspace-model.ts"]),
		);
		expect(previews.map((source) => source.name)).toEqual(
			expect.arrayContaining(["file-preview.tsx", "registry.ts", "table-body.tsx", "html-body.tsx"]),
		);
	});

	it.each(sources)("$name imports only React, the Markdown parser and the library itself", ({ text }) => {
		for (const specifier of specifiers(text))
			expect(specifier).toMatch(/^(react|react-markdown|remark-gfm|\.\.?\/[\w./-]+)$/);
	});

	it.each(sources)("$name makes no requests and never touches a sandbox", ({ text }) => {
		expect(text).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|\bacquire\s*\(/);
		expect(text).not.toMatch(/@kantel\/(sandbox|workspace|contracts|runtime)/);
	});

	it.each(previews)("preview's $name makes no requests and never touches a sandbox", ({ text }) => {
		expect(text).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|\bacquire\s*\(/);
		expect(text).not.toMatch(/@kantel\/(sandbox|workspace|contracts|runtime)/);
	});
});
