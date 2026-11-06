// What scrolls sideways when it's wider than its column: a table with more columns than the page has room for. Two
// things a plain `overflow-x-auto` doesn't say. Its own scrollbar is at its bottom, which in a long list is far below
// the window, so nobody knows there is more to the right: SideScroll's bar is pinned to the bottom of whatever scrolls
// the page (sticky), and sits back under the content once its end is in view. And an edge with more past it casts a
// shadow inward from it, under the text, so the cut-off column reads as cut off rather than as the end.
//
// With `fill`, the content can scroll down as well, in the room its page leaves it (a list page whose table fills the
// window under its header and filters, base.css): while it does, its header row sticks and it shows its own vertical
// scrollbar. The pinned bar stays its horizontal one either way, so which bars show never changes its height, and a
// table near the height where it starts to scroll can't flicker between the two.

import { type ComponentProps, useLayoutEffect, useRef, useState } from "react";

/** The ground the content sits on, which its stuck header row is painted in. */
export type SideScrollSurface = "raised" | "canvas";

interface Edges {
	/**
	 * How far it scrolls sideways (its scrollWidth less its clientWidth), when its content is wider than it; undefined
	 * when it fits. The pinned bar scrolls exactly as far: its spacer is its own width plus this, so the two stay in step
	 * whatever stands between them (the scroller's border, its own vertical scrollbar).
	 */
	readonly range: number | undefined;
	readonly start: boolean;
	readonly end: boolean;
	/** Something in the content takes focus, so Tab into it scrolls it into view; otherwise the scroller takes focus. */
	readonly reachable: boolean;
	/** The content is taller than the scroller: only with `fill`, where the page gives it a height. */
	readonly tall: boolean;
	/**
	 * It is a scroller at all: a table's frame in a phone's column is a list of cards that doesn't scroll (table.css),
	 * and must keep its height rather than fill.
	 */
	readonly scrolls: boolean;
}

const fits: Edges = { range: undefined, start: false, end: false, reachable: true, tall: false, scrolls: true };

const focusable =
	'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function measure(scroller: HTMLElement): Edges {
	const { scrollWidth, clientWidth, scrollLeft, scrollHeight, clientHeight } = scroller;
	// A pixel of slack: zoom and fractional sizes leave the scroll size a rounding over the client size.
	const scrolls = getComputedStyle(scroller).overflowX !== "visible";
	const wide = scrollWidth > clientWidth + 1;
	const tall = scrolls && scrollHeight > clientHeight + 1;
	if (!wide && !tall) return scrolls ? fits : { ...fits, scrolls };
	return {
		range: wide ? scrollWidth - clientWidth : undefined,
		start: wide && scrollLeft > 1,
		end: wide && scrollLeft + clientWidth < scrollWidth - 1,
		reachable: [...scroller.querySelectorAll(focusable)].some((element) => element !== scroller),
		tall,
		scrolls,
	};
}

/** Which edges have more past them, for base.css's shadows. */
const edgesData = (edges: Edges): string | undefined =>
	edges.start && edges.end ? "both" : edges.start ? "start" : edges.end ? "end" : undefined;

const same = (a: Edges, b: Edges) =>
	a.range === b.range &&
	a.start === b.start &&
	a.end === b.end &&
	a.reachable === b.reachable &&
	a.tall === b.tall &&
	a.scrolls === b.scrolls;

/**
 * The header row of a table in a scroller that scrolls down, stuck to its top on the content's ground: over a row's own
 * layers (a row link's content is lifted to z-1 over its overlay). Its hairline is a shadow: a collapsed border stays
 * with the rows when the cell sticks. The scroller's scroll padding is the header's height, so a control focused by Tab
 * is brought out from under it.
 */
const stickyHead = {
	raised:
		"scroll-pt-control-md [&>table>thead_th]:sticky [&>table>thead_th]:top-0 [&>table>thead_th]:z-2 [&>table>thead_th]:bg-raised [&>table>thead_th]:shadow-[inset_0_-1px_0_var(--kt-border)]",
	canvas:
		"scroll-pt-control-md [&>table>thead_th]:sticky [&>table>thead_th]:top-0 [&>table>thead_th]:z-2 [&>table>thead_th]:bg-canvas [&>table>thead_th]:shadow-[inset_0_-1px_0_var(--kt-border)]",
} as const;

/**
 * A container that scrolls sideways when its content is wider than it is, with its scrollbar kept in the window and its
 * cut-off edges shaded. `className` styles the scroller itself (a table's frame); the bar is its next sibling, so in a
 * flex column it takes the column's gap above it. When the content fits there is no bar and no shadow.
 *
 * Wheel, trackpad, touch and keyboard scroll the content as any scroller: Tab to a control in it brings it into view,
 * and content with no control in it makes the scroller itself a tab stop, for the arrow keys. The bar is the same
 * scroll for a pointer, so it's hidden from assistive tech and out of the tab order.
 *
 * `fill` lets it scroll down too, as tall as its page lets it be (base.css's `kt-fill`): while its content is taller
 * than that, its table's header row sticks and its own vertical scrollbar shows beside the pinned bar.
 */
export function SideScroll({
	children,
	className,
	surface = "raised",
	fill = false,
	...rest
}: ComponentProps<"div"> & { surface?: SideScrollSurface; fill?: boolean }) {
	const scroller = useRef<HTMLDivElement>(null);
	const bar = useRef<HTMLDivElement>(null);
	const [edges, setEdges] = useState<Edges>(fits);
	useLayoutEffect(() => {
		const box = scroller.current;
		if (box === null) return;
		const update = () => {
			const next = measure(box);
			setEdges((current) => (same(current, next) ? current : next));
			const rail = bar.current;
			if (rail !== null && rail.scrollLeft !== box.scrollLeft) rail.scrollLeft = box.scrollLeft;
		};
		update();
		// The scroller changes width with the window, the content with its rows: either can start or end the overflow.
		const observer = new ResizeObserver(update);
		observer.observe(box);
		for (const child of box.children) observer.observe(child);
		const children = new MutationObserver(() => {
			for (const child of box.children) observer.observe(child);
			update();
		});
		children.observe(box, { childList: true });
		box.addEventListener("scroll", update, { passive: true });
		return () => {
			observer.disconnect();
			children.disconnect();
			box.removeEventListener("scroll", update);
		};
	}, []);
	const follow = () => {
		const box = scroller.current;
		const rail = bar.current;
		if (box !== null && rail !== null && box.scrollLeft !== rail.scrollLeft) box.scrollLeft = rail.scrollLeft;
	};
	// Scrolling down in its own room: it shows its own vertical scrollbar. Its horizontal one stays hidden for the pinned
	// bar (WebKit and Chromium; Firefox can't hide one axis, so it shows both of its own, thin, beside the pinned bar),
	// so its height is the same with or without its own bars.
	const scrolling = fill && edges.tall;
	return (
		<>
			<div
				{...(edges.reachable ? {} : { tabIndex: 0 })}
				{...rest}
				ref={scroller}
				data-edges={edgesData(edges)}
				className={`kt-side-scroll kt-focusable relative overflow-x-auto ${fill && edges.scrolls ? "kt-table-fill kt-scroll-rounded min-h-0 overflow-y-auto" : ""} ${scrolling ? `${stickyHead[surface]} [&::-webkit-scrollbar:horizontal]:h-0` : "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"} ${className ?? ""}`}
			>
				{children}
			</div>
			<div
				ref={bar}
				aria-hidden="true"
				tabIndex={-1}
				hidden={edges.range === undefined}
				onScroll={follow}
				className="kt-side-scroll-bar sticky bottom-0 z-1 min-w-0 overflow-x-auto overflow-y-hidden bg-canvas"
			>
				<div className="h-px" style={{ width: `calc(100% + ${edges.range ?? 0}px)` }} />
			</div>
		</>
	);
}
