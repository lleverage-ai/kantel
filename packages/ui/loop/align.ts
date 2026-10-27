// The alignment gate: icons, dots, badges and button labels are centred on the text they sit beside, within 1px.
//
// A box's centre is easy to measure and says nothing about where the text looks centred: a line of text is centred
// on its cap height (from the baseline up to the top of an H), not on its line box, whose space above and below the
// letters depends on the font's ascent and descent. So a text's optical centre is taken as baseline − capHeight / 2,
// with the baseline read from the first glyph's box (the font's content area, the same metrics canvas reports) and
// the cap height from canvas measureText("H") in the element's computed font. Measured in the page, so it is the
// font the browser actually used.

import type { Page } from "playwright-core";

export type Misalignment = { check: string; where: string; offset: number };

export const ALIGN_TOLERANCE = 1;

/** Runs in the page: every pair the gate checks, and how far apart their centres are (px, + means lower). */
export function measureAlignment(): Misalignment[] {
	const root = document.querySelector(".hb-app") ?? document.body;
	const canvas = document.createElement("canvas").getContext("2d");
	if (canvas === null) return [];

	const firstText = (element: Element): Text | null => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
			acceptNode: (node) =>
				(node.textContent ?? "").trim() === "" ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT,
		});
		return walker.nextNode() as Text | null;
	};

	/** The optical centre (cap-height midpoint) and baseline of an element's first line of text, in page px. */
	const textLine = (element: Element): { centre: number; baseline: number } | null => {
		const text = firstText(element);
		if (text === null || text.parentElement === null) return null;
		const start = (text.textContent ?? "").search(/\S/);
		const range = document.createRange();
		range.setStart(text, start);
		range.setEnd(text, start + 1);
		const glyph = range.getClientRects()[0];
		if (glyph === undefined || glyph.height === 0) return null;
		const style = getComputedStyle(text.parentElement);
		canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
		const metrics = canvas.measureText("H");
		const contentHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
		// The glyph box is the font's content area; spread any rounding evenly over ascent and descent.
		const scale = glyph.height / contentHeight;
		const baseline = glyph.top + metrics.fontBoundingBoxAscent * scale;
		return { centre: baseline - metrics.actualBoundingBoxAscent / 2, baseline };
	};

	const centre = (element: Element) => {
		const box = element.getBoundingClientRect();
		return box.top + box.height / 2;
	};
	const visible = (element: Element) => {
		const box = element.getBoundingClientRect();
		return box.width > 0 && box.height > 0;
	};
	const describe = (element: Element) => {
		const story = element.closest("[data-story]")?.getAttribute("data-story");
		const label = (element.textContent ?? "").trim().slice(0, 40) || element.getAttribute("aria-label") || "";
		return `${story === null || story === undefined ? "" : `${story}: `}${label}`;
	};

	const out: Misalignment[] = [];
	const compare = (check: string, where: Element, a: number | undefined, b: number | undefined) => {
		if (a === undefined || b === undefined) return;
		out.push({ check, where: describe(where), offset: Math.round((a - b) * 10) / 10 });
	};

	// Buttons: the label's optical centre on the button's centre; an icon beside a label on the label's centre.
	for (const button of root.querySelectorAll(".hb-button")) {
		if (!visible(button)) continue;
		const label = button.querySelector(".hb-button-label");
		const line = label === null ? null : textLine(label);
		if (line !== null) compare("button label", button, line.centre, centre(button));
		const icon = button.querySelector(":scope > .hb-icon, :scope > svg");
		if (icon !== null && visible(icon)) {
			if (line !== null) compare("button icon", button, centre(icon), line.centre);
			else compare("icon button", button, centre(icon), centre(button));
		}
	}
	// Status labels: the dot on its words.
	for (const label of root.querySelectorAll(".hb-status-label")) {
		const dot = label.querySelector(".hb-status-dot");
		const line = textLine(label);
		if (dot !== null && visible(dot) && line !== null) compare("status dot", label, centre(dot), line.centre);
	}
	// List rows: the leading dot or icon on the title's first line.
	for (const row of root.querySelectorAll(".hb-list-row")) {
		const leading = row.querySelector(".hb-list-row-leading > *");
		const title = row.querySelector(".hb-list-row-title");
		const line = title === null ? null : textLine(title);
		if (leading !== null && visible(leading) && line !== null)
			compare("list row leading", row, centre(leading), line.centre);
	}
	// Badges: the words centred in the pill.
	for (const badge of root.querySelectorAll(".hb-badge")) {
		const line = visible(badge) ? textLine(badge) : null;
		if (line !== null) compare("badge text", badge, line.centre, centre(badge));
	}
	// Field rows: label and value on one baseline; a badge or other extra centred on the value's first line.
	for (const row of root.querySelectorAll(".hb-field-row")) {
		const label = row.querySelector(".hb-field-label");
		const value = row.querySelector(".hb-field-value");
		const labelLine = label === null ? null : textLine(label);
		const valueLine = value === null ? null : textLine(value);
		if (labelLine !== null && valueLine !== null)
			compare("field baseline", row, labelLine.baseline, valueLine.baseline);
		const extra = row.querySelector(".hb-field-extra > *");
		if (extra !== null && visible(extra) && valueLine !== null)
			compare("field extra", row, centre(extra), valueLine.centre);
	}
	// Notices: the icon on the first line of text.
	for (const notice of root.querySelectorAll(".hb-notice")) {
		const icon = notice.querySelector(":scope > .hb-icon");
		const text = notice.querySelector(".hb-notice-text");
		const line = text === null ? null : textLine(text);
		if (icon !== null && visible(icon) && line !== null) compare("notice icon", notice, centre(icon), line.centre);
	}
	return out;
}

/** Every measured pair further apart than the tolerance. */
export async function alignment(page: Page): Promise<Misalignment[]> {
	const all = await page.evaluate(measureAlignment);
	return all.filter((pair) => Math.abs(pair.offset) > ALIGN_TOLERANCE);
}
