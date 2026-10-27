import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The workspace components are presentational: the host reads the workspace through its read API and passes them
// what it read. This keeps them that way. They import only React and the library's own modules, never a client,
// a contract package or anything that could reach a sandbox, and they make no requests of their own.

const dir = new URL("../src/workspace/", import.meta.url);
/** Source without its comments, which may name what the code must not use. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = readdirSync(dir)
	.filter((name) => /\.tsx?$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name) && name !== "fixtures.ts")
	.map((name) => ({ name, text: code(readFileSync(new URL(name, dir), "utf8")) }));

const specifiers = (text: string) =>
	[...text.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s+"([^"]+)"/g)].map((m) => m[1] ?? m[2]);

describe("the workspace components", () => {
	it("are all checked", () => {
		expect(sources.map((source) => source.name)).toEqual(
			expect.arrayContaining(["file-tree.tsx", "file-viewer.tsx", "note-viewer.tsx", "workspace-model.ts"]),
		);
	});

	it.each(sources)("$name imports only React and the library itself", ({ text }) => {
		for (const specifier of specifiers(text)) expect(specifier).toMatch(/^(react|\.\.?\/)/);
	});

	it.each(sources)("$name makes no requests and never touches a sandbox", ({ text }) => {
		expect(text).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|\bacquire\s*\(/);
		expect(text).not.toMatch(/@harbour\/(sandbox|workspace|contracts|runtime)/);
	});
});
