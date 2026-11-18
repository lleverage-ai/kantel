// What scrolls sideways when it's wider than its column: a table with more columns than the page has room for. Its own
// scrollbar shows inside its frame, as any scroller's. Two things a plain `overflow-x-auto` doesn't say. That bar is at
// its bottom, which in a long list is far below the window, so nobody knows there is more to the right: while the bottom
// is out of view, a pinned bar shows at the bottom of whatever scrolls the page (sticky), and it goes once the
// scroller's own bar comes into view. And an edge with more past it fades the content into its ground, so the cut-off
// column reads as cut off rather than as the end. The fade deepens over the first few pixels of scroll and thins over
// the last few, so it never pops in or out.
//
// With `fill`, the content scrolls down as well, in the room its page leaves it (a list page whose table fills the
// window under its header and filters, base.css). Its bottom is then in view, so the pinned bar doesn't show; while it
// scrolls down its header row sticks.

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
	/** Something in the content takes focus, so Tab into it scrolls it into view; otherwise the scroller takes focus. */
	readonly reachable: boolean;
	/** The content is taller than the scroller: only with `fill`, where the page gives it a height. */
	readonly tall: boolean;
	/**
	 * It is a scroller at all: a table's frame in a phone's column is a list of cards that doesn't scroll (table.css),
	 * and must keep its height rather than fill.
	 */
	readonly scrolls: boolean;
	/**
	 * Where its content shows, inside its border and clear of its own scrollbars, for the fades over its edges: they sit
	 * over the scroller rather than in it, so they stay put as it scrolls.
	 */
	readonly view: View;
}

interface View {
	readonly top: number;
	readonly left: number;
	readonly width: number;
	readonly height: number;
}

const noView: View = { top: 0, left: 0, width: 0, height: 0 };

const fits: Edges = { range: undefined, reachable: true, tall: false, scrolls: true, view: noView };

/** How far into its scroll, in pixels, an edge's fade takes to deepen fully, and from its end to thin away. */
const FADE_RAMP = 32;

/**
 * Each fade's depth follows how far there is to scroll towards its edge, so it eases in and out with the scroll rather
 * than switching. Set on the elements, not in state: it changes with every scroll event.
 */
function paintFades(box: HTMLElement, start: HTMLElement | null, end: HTMLElement | null) {
	const past = Math.abs(box.scrollLeft);
	const left = box.scrollWidth - box.clientWidth - past;
	if (start !== null) start.style.opacity = `${Math.min(Math.max(past / FADE_RAMP, 0), 1)}`;
	if (end !== null) end.style.opacity = `${Math.min(Math.max(left / FADE_RAMP, 0), 1)}`;
}

const focusable =
	'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function measure(scroller: HTMLElement): Edges {
	const { scrollWidth, clientWidth, scrollHeight, clientHeight, clientTop, clientLeft } = scroller;
	// A pixel of slack: zoom and fractional sizes leave the scroll size a rounding over the client size.
	const scrolls = getComputedStyle(scroller).overflowX !== "visible";
	const wide = scrollWidth > clientWidth + 1;
	const tall = scrolls && scrollHeight > clientHeight + 1;
	if (!wide && !tall) return scrolls ? fits : { ...fits, scrolls };
	return {
		range: wide ? scrollWidth - clientWidth : undefined,
		reachable: [...scroller.querySelectorAll(focusable)].some((element) => element !== scroller),
		tall,
		scrolls,
		view: wide ? { top: clientTop, left: clientLeft, width: clientWidth, height: clientHeight } : noView,
	};
}

const same = (a: Edges, b: Edges) =>
	a.range === b.range &&
	a.reachable === b.reachable &&
	a.tall === b.tall &&
	a.scrolls === b.scrolls &&
	a.view.top === b.view.top &&
	a.view.left === b.view.left &&
	a.view.width === b.view.width &&
	a.view.height === b.view.height;

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

/** The pinned bar over the rows at the window's bottom, on their ground, with a hairline over it. */
const pinnedGround = {
	raised: "bg-raised shadow-[inset_0_1px_0_var(--kt-border)]",
	canvas: "bg-canvas shadow-[inset_0_1px_0_var(--kt-border)]",
} as const;

/** An edge's fade, from the content's ground at the edge to clear: over the rows, under nothing a pointer needs. */
const fade = {
	raised: { start: "bg-linear-to-r from-raised to-transparent", end: "bg-linear-to-l from-raised to-transparent" },
	canvas: { start: "bg-linear-to-r from-canvas to-transparent", end: "bg-linear-to-l from-canvas to-transparent" },
} as const;

/**
 * A container that scrolls sideways when its content is wider than it is, with its own scrollbar inside its frame, a
 * pinned bar at the window's bottom while that one is out of view, and its cut-off edges faded. `className` styles the
 * scroller itself (a table's frame); it, its fades and the pinned bar sit in a wrapper of their own. When the content
 * fits there is no bar and no fade.
 *
 * Wheel, trackpad, touch and keyboard scroll the content as any scroller: Tab to a control in it brings it into view,
 * and content with no control in it makes the scroller itself a tab stop, for the arrow keys. The pinned bar is the
 * same scroll for a pointer, so it's hidden from assistive tech and out of the tab order.
 *
 * `fill` lets it scroll down too, as tall as its page lets it be (base.css's `kt-fill`). Its bottom is then always in
 * view, so the pinned bar doesn't show, and while its content is taller than it, its table's header row sticks.
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
	const startFade = useRef<HTMLDivElement>(null);
	const endFade = useRef<HTMLDivElement>(null);
	const [edges, setEdges] = useState<Edges>(fits);
	// The pinned bar is showing: the scroller's bottom, and its own bar with it, is below the window.
	const [pinned, setPinned] = useState(false);
	useLayoutEffect(() => {
		const box = scroller.current;
		if (box === null) return;
		const update = () => {
			const next = measure(box);
			setEdges((current) => (same(current, next) ? current : next));
			paintFades(box, startFade.current, endFade.current);
			const rail = bar.current;
			if (rail !== null && rail.scrollLeft !== box.scrollLeft) rail.scrollLeft = box.scrollLeft;
			place();
		};
		// The pinned bar takes no room: it is pulled up over the scroller's last strip, where it rests over the scroller's
		// own bar. It shows only while sticky has lifted it off that resting place, so one bar shows at a time.
		const place = () => {
			const rail = bar.current;
			if (rail === null || rail.hidden) {
				setPinned(false);
				return;
			}
			rail.style.marginTop = `-${rail.offsetHeight}px`;
			setPinned(rail.getBoundingClientRect().bottom < box.getBoundingClientRect().bottom - 1);
		};
		let frame = 0;
		const onPageScroll = () => {
			if (frame !== 0) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				place();
			});
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
		// Whatever scrolls the page, the window or a panel round it: a scroll event doesn't bubble, so catch it on the way
		// down.
		document.addEventListener("scroll", onPageScroll, { capture: true, passive: true });
		window.addEventListener("resize", onPageScroll, { passive: true });
		return () => {
			observer.disconnect();
			children.disconnect();
			box.removeEventListener("scroll", update);
			document.removeEventListener("scroll", onPageScroll, { capture: true });
			window.removeEventListener("resize", onPageScroll);
			cancelAnimationFrame(frame);
		};
	}, []);
	const filling = fill && edges.scrolls;
	const wide = edges.range !== undefined;
	// The fades mount once the content overflows, and the pinned bar shows: give the fades their depth before they paint,
	// and the bar its place.
	// biome-ignore lint/correctness/useExhaustiveDependencies: they mount and unmount as the overflow comes and goes
	useLayoutEffect(() => {
		const box = scroller.current;
		if (box === null) return;
		paintFades(box, startFade.current, endFade.current);
		const rail = bar.current;
		if (rail === null || rail.hidden) {
			setPinned(false);
			return;
		}
		rail.style.marginTop = `-${rail.offsetHeight}px`;
		setPinned(rail.getBoundingClientRect().bottom < box.getBoundingClientRect().bottom - 1);
	}, [edges.range]);
	const follow = () => {
		const box = scroller.current;
		const rail = bar.current;
		if (box !== null && rail !== null && box.scrollLeft !== rail.scrollLeft) box.scrollLeft = rail.scrollLeft;
	};
	// Its own scrollbars always show, inside its frame. Filling its page, its bottom is in view, so the pinned bar never
	// shows; under a window too short to fill (base.css), the page scrolls and it does, as for any table.
	return (
		<div className={`relative isolate min-w-0 ${filling ? "kt-fill flex min-h-0 flex-col" : ""}`}>
			<div
				{...(edges.reachable ? {} : { tabIndex: 0 })}
				{...rest}
				ref={scroller}
				className={`kt-side-scroll kt-focusable kt-scroll-rounded relative overflow-x-auto ${filling ? "kt-table-fill min-h-0 overflow-y-auto" : ""} ${filling && edges.tall ? stickyHead[surface] : ""} ${className ?? ""}`}
			>
				{children}
			</div>
			{wide ? (
				<div
					aria-hidden="true"
					className="pointer-events-none absolute z-3 overflow-hidden rounded-panel"
					style={{ ...edges.view }}
				>
					<div ref={startFade} className={`absolute inset-y-0 left-0 w-8 opacity-0 ${fade[surface].start}`} />
					<div ref={endFade} className={`absolute inset-y-0 right-0 w-8 opacity-0 ${fade[surface].end}`} />
				</div>
			) : null}
			<div
				ref={bar}
				aria-hidden="true"
				tabIndex={-1}
				hidden={!wide}
				onScroll={follow}
				className={`kt-side-scroll-bar kt-scroll-rounded sticky bottom-0 z-4 mx-px min-w-0 overflow-x-auto overflow-y-hidden outline-none ${pinnedGround[surface]} ${pinned ? "" : "pointer-events-none invisible"}`}
			>
				<div className="h-px" style={{ width: `calc(100% + ${edges.range ?? 0}px)` }} />
			</div>
		</div>
	);
}
