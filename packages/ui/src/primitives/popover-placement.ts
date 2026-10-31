import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";

// Where a popover anchored to a control opens: above it or below it, and how tall it may be there. The composer's
// pickers (model, project, repository, branch, thinking, access) open upward from the composer's toolbar, which is
// right while the composer is docked at the foot of a session. On a new session the composer sits in the middle of
// the window, inside a scrolling column under the header, and a full model list doesn't fit above it: the column
// cut the popover's top (the search field and the provider rail) off under the header. So a popover opens on its
// preferred side when it fits there, else on the side with more room, and is never taller than the room on that
// side, its list scrolling inside it while the search field stays put. As Radix's and Floating UI's collision
// handling do, without a portal: a portal would take the popover out of the composer, whose focus and outside-click
// handling look for it inside.

export type PopoverSide = "top" | "bottom";

/** A span of the window's height, in CSS pixels from its top. */
export type Span = { readonly top: number; readonly bottom: number };

/** Room kept between a popover and the edge of whatever clips it (8px, --kt-step-2). */
export const POPOVER_EDGE = 8;
/** The gap between the control and its popover (6px, `--spacing(1.5)` in `popoverSide`). */
export const POPOVER_GAP = 6;

/**
 * The popover's position on its side of the control, as Tailwind classes: 6px off the control's top edge, or 6px
 * below its bottom edge, moved down past the surface it sits in (`--kt-popover-drop`, see `usePopoverPlacement`).
 */
export const popoverSide: Record<PopoverSide, string> = {
	top: "bottom-[calc(100%+--spacing(1.5))]",
	bottom: "top-[calc(100%+--spacing(1.5)+var(--kt-popover-drop))]",
};

/**
 * Marks the surface a control sits in (the composer's box): a popover that opens downward opens below its bottom edge,
 * not over the rest of it, so it never covers the surface's other controls (a toolbar's second row, the send button).
 */
export const POPOVER_EDGE_ATTRIBUTE = "data-popover-edge";

/** Caps the popover at the room `usePopoverPlacement` measured. Unset (no cap) until it has measured. */
export const popoverRoom = "max-h-(--kt-popover-room)";

export type PopoverPlace = {
	readonly side: PopoverSide;
	/** The most height the popover has on that side, in CSS pixels. */
	readonly room: number;
};

/**
 * Which side a popover of natural `height` opens on, beside a control at `anchor`, inside the `bounds` that clip it:
 * the `preferred` side when it fits there whole, else the side with more room (the preferred one on a tie). The room
 * is what that side has, less the gap to the control and an edge's margin.
 */
export function placePopover(
	anchor: Span,
	bounds: Span,
	height: number,
	preferred: PopoverSide = "top",
	gap = POPOVER_GAP,
	edge = POPOVER_EDGE,
): PopoverPlace {
	const above = Math.max(0, Math.floor(anchor.top - gap - bounds.top - edge));
	const below = Math.max(0, Math.floor(bounds.bottom - edge - anchor.bottom - gap));
	const room = { top: above, bottom: below };
	const other: PopoverSide = preferred === "top" ? "bottom" : "top";
	const side = height <= room[preferred] || room[preferred] >= room[other] ? preferred : other;
	return { side, room: room[side] };
}

/**
 * The part of the window's height an element inside `element` can draw in: the window, cut by every ancestor that
 * clips its overflow (a scrolling column, an `overflow: hidden` frame), up to a fixed ancestor, which the ones above
 * it don't clip.
 */
export function clipSpan(element: Element): Span {
	const view = element.ownerDocument.defaultView;
	let top = 0;
	let bottom = view?.innerHeight ?? Number.POSITIVE_INFINITY;
	for (let node = element.parentElement; node !== null; node = node.parentElement) {
		if (node === element.ownerDocument.body || node === element.ownerDocument.documentElement) break;
		const style = getComputedStyle(node);
		if (style.overflowY !== "visible" || style.overflowX !== "visible") {
			const rect = node.getBoundingClientRect();
			top = Math.max(top, rect.top);
			bottom = Math.min(bottom, rect.bottom);
		}
		if (style.position === "fixed") break;
	}
	return { top, bottom };
}

/**
 * Places an open popover beside its control: `anchor` is the element it's positioned against (the picker's root,
 * `position: relative`), `popover` the popover. Measures once it opens, before it paints, and again as the window
 * resizes or anything scrolls, so the popover follows its control. Returns the side, for `popoverSide`, and the style
 * that sets `--kt-popover-room` for `popoverRoom` and `--kt-popover-drop` for `popoverSide`'s `bottom`: how far the
 * surface the control sits in (its nearest `data-popover-edge` ancestor) reaches below it.
 *
 * Upward is preferred: it's where the composer's pickers have always opened, as T3 Code's and Claude's do, and a
 * docked composer has the whole transcript above it.
 *
 * The popover's own height is read on opening, before it's capped: its content decides it (a picker's list keeps one
 * height as it filters, and a menu's levels don't change while it's open).
 */
export function usePopoverPlacement(
	open: boolean,
	anchor: RefObject<HTMLElement | null>,
	popover: RefObject<HTMLElement | null>,
	preferred: PopoverSide = "top",
): { side: PopoverSide; style: CSSProperties } {
	const [place, setPlace] = useState<PopoverPlace & { drop: number }>();
	const natural = useRef(0);

	useLayoutEffect(() => {
		if (!open) {
			setPlace(undefined);
			return;
		}
		const at = anchor.current;
		const panel = popover.current;
		if (at === null || panel === null) return;
		// Uncapped on the first render after opening: its height now is the one it wants.
		natural.current = panel.getBoundingClientRect().height;
		const edge = at.closest(`[${POPOVER_EDGE_ATTRIBUTE}]`);
		const measure = () => {
			const rect = at.getBoundingClientRect();
			const drop = Math.max(0, Math.round((edge?.getBoundingClientRect().bottom ?? rect.bottom) - rect.bottom));
			const span = { top: rect.top, bottom: rect.bottom + drop };
			const next = { ...placePopover(span, clipSpan(at), natural.current, preferred), drop };
			setPlace((current) =>
				current !== undefined && current.side === next.side && current.room === next.room && current.drop === drop
					? current
					: next,
			);
		};
		measure();
		const view = at.ownerDocument.defaultView;
		view?.addEventListener("resize", measure);
		at.ownerDocument.addEventListener("scroll", measure, true);
		return () => {
			view?.removeEventListener("resize", measure);
			at.ownerDocument.removeEventListener("scroll", measure, true);
		};
	}, [open, anchor, popover, preferred]);

	// Uncapped and undropped until measured, so the first measurement reads the popover's own height.
	const vars: Record<string, string> =
		place === undefined
			? { "--kt-popover-drop": "0px" }
			: { "--kt-popover-room": `${place.room}px`, "--kt-popover-drop": `${place.drop}px` };
	return { side: place?.side ?? preferred, style: vars as CSSProperties };
}
