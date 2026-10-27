import { describe, expect, it } from "vitest";
import { splitBlocks } from "./markdown.tsx";

describe("splitBlocks", () => {
	// The first two are ported from the console's session.test.ts.
	it("splits at blank lines but never inside a code fence", () => {
		const text = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n- one\n- two";
		expect(splitBlocks(text)).toEqual(["Intro\n", "```ts\nconst a = 1;\n\nconst b = 2;\n```\n", "- one\n- two"]);
	});

	it("keeps earlier blocks byte-identical as text streams in", () => {
		const full = "Para one.\n\nPara two is longer.\n\n```\ncode\n```";
		const early = splitBlocks(full.slice(0, 22));
		const late = splitBlocks(full);
		expect(late.slice(0, early.length - 1)).toEqual(early.slice(0, -1));
	});

	it("keeps an unclosed fence, blank lines and all, in the last block while it streams", () => {
		expect(splitBlocks("Para\n\n```\ncode\n\nmore")).toEqual(["Para\n", "```\ncode\n\nmore"]);
	});

	it("closes a fence only with the same character, at least as long", () => {
		const text = "~~~~\na\n```\n\nb\n~~~~\n\nc";
		expect(splitBlocks(text)).toEqual(["~~~~\na\n```\n\nb\n~~~~\n", "c"]);
	});

	it("drops empty blocks from runs of blank or whitespace-only lines", () => {
		expect(splitBlocks("a\n\n\n   \nb")).toEqual(["a\n", "b"]);
		expect(splitBlocks("a\n\n")).toEqual(["a\n"]);
		expect(splitBlocks("")).toEqual([]);
		expect(splitBlocks("\n\n  \n")).toEqual([]);
	});
});
