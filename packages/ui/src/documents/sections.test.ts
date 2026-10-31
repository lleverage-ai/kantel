import { describe, expect, it } from "vitest";
import { rehypeSections } from "../workspace/note-sections.tsx";
import { folds, hiddenBy } from "./sections.ts";

describe("folds", () => {
	it("folds headings one to four, but not a first-block title", () => {
		expect(folds(2, 0)).toBe(true);
		expect(folds(1, 0)).toBe(false);
		expect(folds(1, 3)).toBe(true);
		expect(folds(4, 1)).toBe(true);
		expect(folds(5, 1)).toBe(false);
	});
});

describe("hiddenBy", () => {
	// # Title, ## A, p, ### A.1, p, ## B, p
	const levels = [1, 2, undefined, 3, undefined, 2, undefined];

	it("shows everything when nothing is folded", () => {
		expect(hiddenBy(levels, new Set())).toEqual([-1, -1, -1, -1, -1, -1, -1]);
	});

	it("hides a folded heading's blocks up to the next heading of its level or above", () => {
		expect(hiddenBy(levels, new Set([1]))).toEqual([-1, -1, 1, 1, 1, -1, -1]);
	});

	it("hides only a sub-section's own blocks", () => {
		expect(hiddenBy(levels, new Set([3]))).toEqual([-1, -1, -1, -1, 3, -1, -1]);
	});

	it("hides a folded heading inside a folded section with it", () => {
		expect(hiddenBy(levels, new Set([1, 3]))).toEqual([-1, -1, 1, 1, 1, -1, -1]);
	});

	it("never folds a first-block title", () => {
		expect(hiddenBy(levels, new Set([0]))).toEqual([-1, -1, -1, -1, -1, -1, -1]);
	});
});

describe("rehypeSections", () => {
	const el = (tagName: string) => ({ type: "element", tagName, children: [] });
	const text = { type: "text", value: "\n" };

	it("nests the blocks under each heading that folds", () => {
		const tree = { type: "root", children: [el("h1"), text, el("h2"), el("p"), el("h3"), el("p"), el("h2"), el("p")] };
		rehypeSections()(tree);
		const shape = (node: { tagName?: string; type: string; children?: unknown[] }): unknown =>
			node.tagName === "section"
				? (node.children as (typeof node)[]).filter((child) => child.type === "element").map(shape)
				: node.tagName;
		expect(tree.children.filter((child) => child.type === "element").map(shape)).toEqual([
			"h1",
			["h2", "p", ["h3", "p"]],
			["h2", "p"],
		]);
	});
});
