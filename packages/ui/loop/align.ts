// The alignment gate: icons, dots, badges and button labels are centred on the text they sit beside, within 1px.
//
// A box's centre is easy to measure and says nothing about where the text looks centred: a line of text is centred
// on its cap height (from the baseline up to the top of an H), not on its line box, whose space above and below the
// letters depends on the font's ascent and descent. So a text's optical centre is taken as baseline − capHeight / 2,
// with the baseline read from the first glyph's box (the font's content area, the same metrics canvas reports) and
// the cap height from canvas measureText("H") in the element's computed font. Measured in the page, so it is the
// font the browser actually used.

import type { Page } from "playwright-core";

/** `offset` is null when an element that should be checked could not be measured, which also fails. */
export type Misalignment = { check: string; where: string; offset: number | null };

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
	// Visible content the gate should check but can't find its parts for: a failure, never a silent skip.
	const unmeasured = (check: string, where: Element) => {
		out.push({ check, where: describe(where), offset: null });
	};

	// Buttons: the label's optical centre on the button's centre; an icon beside a label on the label's centre.
	for (const button of root.querySelectorAll(".hb-button")) {
		if (!visible(button)) continue;
		const label = button.querySelector(".hb-button-label");
		const line = label === null ? null : textLine(label);
		if (line !== null) compare("button label", button, line.centre, centre(button));
		else if ((button.textContent ?? "").trim() !== "") unmeasured("button label", button);
		// A busy button's spinner stands in for its icon, so it is held to the same line.
		const icon = button.querySelector(":scope > .hb-icon, :scope > svg, :scope > .hb-spinner");
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
	// A working session's spinner on its "Working 12s".
	for (const status of root.querySelectorAll(".hb-session-working")) {
		const spinner = status.querySelector(":scope > .hb-spinner");
		const text = status.querySelector(".hb-session-working-text");
		const line = text === null || !visible(status) ? null : textLine(text);
		if (spinner === null || !visible(status)) continue;
		if (line === null) unmeasured("working spinner", status);
		else compare("working spinner", status, centre(spinner), line.centre);
	}
	// The live activity row's brain on its "Thinking".
	for (const row of root.querySelectorAll(".hb-live-activity")) {
		if (!visible(row)) continue;
		const icon = row.querySelector(".hb-live-activity-icon > *");
		const text = row.querySelector(".hb-live-activity-text");
		const line = text === null ? null : textLine(text);
		if (icon === null || line === null) unmeasured("activity icon", row);
		else compare("activity icon", row, centre(icon), line.centre);
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
	// Tool-call rows: the icon (or spinner) and the chevron on the label's line, and the start time on the label's
	// baseline. The time shows only on hover or focus, so a hidden one is shown for the measure (the two properties its
	// hover rule sets) and put back: every row's time is checked, not just a hovered one's. A part that is missing or
	// unmeasurable fails, rather than passing unchecked.
	for (const row of root.querySelectorAll(".hb-tool-row")) {
		if (!visible(row)) continue;
		const icon = row.querySelector(".hb-tool-icon > :not(.hb-sr-only)");
		const label = row.querySelector(".hb-tool-label");
		const line = label === null ? null : textLine(label);
		if (line === null) {
			unmeasured("tool icon", row);
			continue;
		}
		if (icon !== null && visible(icon)) compare("tool icon", row, centre(icon), line.centre);
		else unmeasured("tool icon", row);
		const chevron = row.querySelector(".hb-tool-chevron");
		if (chevron !== null && visible(chevron)) compare("tool chevron", row, centre(chevron), line.centre);
		else unmeasured("tool chevron", row);
		const stamp = row.querySelector<HTMLElement>(".hb-tool-stamp");
		if (stamp === null) {
			unmeasured("tool time", row);
			continue;
		}
		const hidden = getComputedStyle(stamp).opacity === "0";
		if (hidden) {
			stamp.style.position = "static";
			stamp.style.opacity = "1";
		}
		const stampLine = textLine(stamp);
		const shownLine = hidden ? textLine(label as Element) : line;
		if (hidden) {
			stamp.style.removeProperty("position");
			stamp.style.removeProperty("opacity");
		}
		if (stampLine === null || shownLine === null) unmeasured("tool time", row);
		else compare("tool time", row, stampLine.baseline, shownLine.baseline);
	}
	// Disclosures: the chevron on the summary's words.
	for (const summary of root.querySelectorAll(".hb-disclosure-summary")) {
		const chevron = summary.querySelector(".hb-disclosure-chevron");
		if (chevron === null || !visible(chevron)) continue;
		const line = textLine(summary);
		if (line === null) unmeasured("disclosure chevron", summary);
		else compare("disclosure chevron", summary, centre(chevron), line.centre);
	}
	// Breadcrumbs: every crumb and slash on the current item's baseline.
	for (const trail of root.querySelectorAll(".hb-breadcrumbs-list")) {
		if (!visible(trail)) continue;
		const current = trail.querySelector(".hb-breadcrumbs-current");
		// A title still loading is a skeleton, with no line of text to measure against.
		if (current?.querySelector(".hb-skeleton") !== null) continue;
		const line = current === null ? null : textLine(current);
		if (line === null) {
			unmeasured("breadcrumb baseline", trail);
			continue;
		}
		for (const item of trail.querySelectorAll(".hb-breadcrumbs-parent, .hb-breadcrumbs-separator")) {
			// Short of room the outer parents are hidden; there's nothing to line up.
			if (!visible(item)) continue;
			const other = textLine(item);
			if (other === null) unmeasured("breadcrumb baseline", item);
			else compare("breadcrumb baseline", item, other.baseline, line.baseline);
		}
	}
	// The session header: the trail's words on the centre of the icon buttons beside it.
	for (const header of root.querySelectorAll(".hb-session-header")) {
		if (!visible(header)) continue;
		const current = header.querySelector(".hb-breadcrumbs-current");
		if (current === null || current.querySelector(".hb-skeleton") !== null) continue;
		const line = textLine(current);
		if (line === null) {
			unmeasured("header trail", header);
			continue;
		}
		for (const button of header.querySelectorAll(".hb-session-header-actions .hb-icon-button, .hb-session-header-back"))
			if (visible(button)) compare("header trail", button, line.centre, centre(button));
		// The connection, when it says something: its words on the trail's line, its spinner on its words.
		for (const words of header.querySelectorAll(".hb-connection > span:not(.hb-sr-only, .hb-spinner)")) {
			const said = visible(words) ? textLine(words) : null;
			if (said === null) continue;
			compare("header connection", words, said.centre, line.centre);
			const spinner = words.parentElement?.querySelector(":scope > .hb-spinner");
			if (spinner != null && visible(spinner)) compare("header spinner", words, centre(spinner), said.centre);
		}
	}
	// Notices: the icon on the first line of text.
	for (const notice of root.querySelectorAll(".hb-notice")) {
		const icon = notice.querySelector(":scope > .hb-icon");
		const text = notice.querySelector(".hb-notice-text");
		const line = text === null ? null : textLine(text);
		if (icon !== null && visible(icon) && line !== null) compare("notice icon", notice, centre(icon), line.centre);
	}

	// The composer. A control with words: the words on the control's centre, its icons on the words. A part that
	// should be there and can't be measured fails.
	const labelled = (
		check: string,
		control: Element,
		label: Element | null,
		icons: Iterable<Element>,
		centred: boolean,
	): { centre: number; baseline: number } | null => {
		if (!visible(control)) return null;
		const line = label === null ? null : textLine(label);
		if (line === null) {
			unmeasured(`${check} label`, control);
			return null;
		}
		if (centred) compare(`${check} label`, control, line.centre, centre(control));
		for (const icon of icons) if (visible(icon)) compare(`${check} icon`, control, centre(icon), line.centre);
		return line;
	};
	// Model picker: the trigger's name on its centre, the spark and chevron on the name; each row's capability icon,
	// tick and "Default" on the model's name (the description, when there is one, sits below it).
	for (const trigger of root.querySelectorAll(".hb-model-trigger"))
		labelled(
			"model trigger",
			trigger,
			trigger.querySelector(".hb-model-trigger-label"),
			trigger.querySelectorAll(":scope > .hb-icon"),
			true,
		);
	for (const option of root.querySelectorAll(".hb-model-option")) {
		const name = option.querySelector(".hb-model-option-name");
		const single = option.querySelector(".hb-model-option-detail") === null;
		const line = labelled(
			"model row",
			option,
			name,
			option.querySelectorAll(".hb-model-option-cap, .hb-model-option-check > .hb-icon"),
			single,
		);
		const badge = option.querySelector(".hb-model-option-default");
		const badgeLine = badge === null ? null : textLine(badge);
		if (line !== null && badgeLine !== null) compare("model row default", option, badgeLine.baseline, line.baseline);
	}
	// Thinking picker: the level on its button's centre and on the model's name beside it; each row's name on the row's
	// centre, the tick on the name and "Default" on its baseline.
	for (const trigger of root.querySelectorAll(".hb-thinking-trigger")) {
		const line = labelled("thinking trigger", trigger, trigger.querySelector(".hb-thinking-trigger-label"), [], true);
		const model = trigger.closest(".hb-composer-controls")?.querySelector(".hb-model-trigger .hb-model-trigger-label");
		const modelLine = model === null || model === undefined ? null : textLine(model);
		if (line !== null && modelLine !== null) compare("thinking on model", trigger, line.baseline, modelLine.baseline);
	}
	for (const option of root.querySelectorAll(".hb-thinking-option")) {
		const line = labelled(
			"thinking row",
			option,
			option.querySelector(".hb-thinking-option-name"),
			option.querySelectorAll(".hb-thinking-option-check > .hb-icon"),
			true,
		);
		const badge = option.querySelector(".hb-thinking-option-default");
		const badgeLine = badge === null ? null : textLine(badge);
		if (line !== null && badgeLine !== null) compare("thinking row default", option, badgeLine.baseline, line.baseline);
	}
	// The search field's magnifier on the field's words. A field has no text node to measure, but a one-line field
	// centres its line in its content box, so its baseline is that centre plus half the font's ascent less its descent.
	for (const search of root.querySelectorAll(".hb-model-search")) {
		const icon = search.querySelector(":scope > .hb-icon");
		const input = search.querySelector("input");
		if (icon === null || input === null || !visible(icon)) continue;
		const style = getComputedStyle(input);
		canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
		const metrics = canvas.measureText("H");
		const box = input.getBoundingClientRect();
		const top = box.top + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.borderTopWidth);
		const bottom = box.bottom - Number.parseFloat(style.paddingBottom) - Number.parseFloat(style.borderBottomWidth);
		const baseline = (top + bottom) / 2 + (metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2;
		compare("model search icon", search, centre(icon), baseline - metrics.actualBoundingBoxAscent / 2);
	}
	// Attachment chips (files and pasted text): the name on the chip's centre, the icon and buttons on the name, the
	// size on the name's baseline.
	for (const chip of root.querySelectorAll(".hb-composer-chip")) {
		const line = labelled(
			"attachment chip",
			chip,
			chip.querySelector(".hb-composer-chip-name"),
			chip.querySelectorAll(":scope > .hb-icon, .hb-composer-chip-button > .hb-icon"),
			true,
		);
		for (const meta of chip.querySelectorAll(".hb-composer-chip-meta, .hb-composer-progress-text")) {
			const metaLine = visible(meta) ? textLine(meta) : null;
			if (line !== null && metaLine !== null) compare("attachment chip size", chip, metaLine.baseline, line.baseline);
		}
	}
	// Image thumbnails' remove and retry buttons, and a resting file square: the icon on its box.
	for (const box of root.querySelectorAll(
		".hb-composer-thumb-remove, .hb-composer-thumb-retry, span.hb-composer-rest-thumb",
	)) {
		const icon = box.querySelector(":scope > .hb-icon");
		if (icon !== null && visible(box)) compare("composer icon box", box, centre(icon), centre(box));
	}
	// The resting count (+2) on the resting squares' centre, the upload percentage on its veil.
	for (const more of root.querySelectorAll(".hb-composer-rest-more")) {
		const row = more.parentElement;
		const square = row?.querySelector(".hb-composer-rest-thumb");
		const line = visible(more) ? textLine(more) : null;
		if (square !== null && square !== undefined && line !== null)
			compare("resting count", more, line.centre, centre(square));
	}
	// Notes (a blocked send, a failed upload) and the folded reason: the icon on the first line.
	for (const note of root.querySelectorAll(".hb-composer-note"))
		labelled(
			"composer note",
			note,
			note.querySelector(":scope > span"),
			note.querySelectorAll(":scope > .hb-icon"),
			false,
		);
	// Words beside the primary action (Send, Steer, Stop): a resting composer's one-line field and a disabled
	// composer's one-line reason, level with the button. A field has no text node, so its first line is placed from its
	// font: the line box starts at the content box's top, with the font's content area centred in it.
	for (const composer of root.querySelectorAll(".hb-composer")) {
		const action = composer.querySelector(".hb-composer-action");
		if (action === null || !visible(action)) continue;
		const field = composer.hasAttribute("data-rest") ? composer.querySelector("textarea") : null;
		if (field !== null && visible(field)) {
			const style = getComputedStyle(field);
			canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			const metrics = canvas.measureText("H");
			const line = Number.parseFloat(style.lineHeight);
			const top =
				field.getBoundingClientRect().top +
				Number.parseFloat(style.paddingTop) +
				Number.parseFloat(style.borderTopWidth) -
				field.scrollTop;
			const baseline = top + line / 2 + (metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2;
			if (Number.isFinite(line))
				compare("resting field", composer, baseline - metrics.actualBoundingBoxAscent / 2, centre(action));
			else unmeasured("resting field", composer);
		}
		const reason = composer.querySelector(".hb-composer-reason-text");
		if (reason !== null && visible(reason)) {
			const line = textLine(reason);
			const size = Number.parseFloat(getComputedStyle(reason).fontSize);
			const oneLine = reason.getBoundingClientRect().height < size * 2;
			if (line === null) unmeasured("disabled reason", composer);
			else if (oneLine) compare("disabled reason", composer, line.centre, centre(action));
		}
	}
	// The send hint: the key's word on the words beside it.
	for (const hint of root.querySelectorAll(".hb-composer-hint")) {
		const key = hint.querySelector(".hb-kbd");
		const words = hint.querySelector(":scope > span:not(.hb-kbd)");
		const keyLine = key === null || !visible(hint) ? null : textLine(key);
		const wordsLine = words === null ? null : textLine(words);
		if (keyLine !== null && wordsLine !== null && key !== null) {
			compare("send hint key", hint, keyLine.centre, centre(key));
			compare("send hint words", hint, wordsLine.centre, centre(key));
		}
	}
	return out;
}

/** Every measured pair further apart than the tolerance. */
export async function alignment(page: Page): Promise<Misalignment[]> {
	const all = await page.evaluate(measureAlignment);
	return all.filter((pair) => pair.offset === null || Math.abs(pair.offset) > ALIGN_TOLERANCE);
}
