// biome-ignore lint/correctness/noNodejsModules: the test reads the approved SVGs from disk, in Node, to hold the components to them.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ENDORSEMENT, FULCRUM, TILE, WORDMARK } from "./artwork.ts";
import { KantelLockup, KantelMark, KantelWordmark } from "./kantel.tsx";

const svg = (name: string) => readFileSync(new URL(`./artwork/${name}.svg`, import.meta.url), "utf8");
const outlines = (markup: string) => [...markup.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]);

describe("Kantel artwork", () => {
	it("draws the approved outlines, path for path, in the same order", () => {
		expect(outlines(svg("kantel-lockup-endorsed-on-light"))).toEqual(
			[TILE, FULCRUM, ...WORDMARK, ...ENDORSEMENT].map((shape) => shape.d),
		);
		const lockup = renderToStaticMarkup(createElement(KantelLockup, { endorsed: true }));
		expect(outlines(lockup)).toEqual(outlines(svg("kantel-lockup-endorsed-on-light")));
		expect(outlines(renderToStaticMarkup(createElement(KantelLockup)))).toEqual(
			outlines(svg("kantel-lockup-horizontal-on-light")),
		);
		expect(outlines(renderToStaticMarkup(createElement(KantelWordmark)))).toEqual(
			outlines(svg("kantel-wordmark-on-light")),
		);
	});

	it("takes its colours from the theme, not the file", () => {
		const markup = renderToStaticMarkup(createElement(KantelLockup, { endorsed: true }));
		expect(markup).not.toMatch(/fill="#/);
		expect(markup).toContain("fill-brand-ink");
		expect(markup).toContain("fill-brand-fulcrum");
	});

	it("is named when it stands for the product, and hidden when it is decoration", () => {
		const named = renderToStaticMarkup(createElement(KantelLockup, { title: "Kantel" }));
		expect(named).toContain('role="img"');
		expect(named).toContain('aria-label="Kantel"');
		const decoration = renderToStaticMarkup(createElement(KantelMark));
		expect(decoration).toContain('aria-hidden="true"');
		expect(decoration).not.toContain("role=");
	});
});
