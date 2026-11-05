import {
	cloneElement,
	type FocusEvent,
	isValidElement,
	type PointerEvent,
	type ReactElement,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { QuestionIcon } from "./icons.tsx";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/*
 * A tooltip: a few words about what's under the pointer or the keyboard's focus, in a small raised panel above it (or
 * below, where there's no room above). It is on the page's body, as a menu is, so a table's scrolling frame or a row's
 * covering link never cuts it off, and it is placed with fixed coordinates the component measures. The browser's own
 * `title` shows late, can't be styled and never shows on focus; this one shows after a short wait, at once while
 * another has just been shown (moving along a row of them), on focus too, and Escape hides it.
 */

/** How long the pointer rests before a tooltip shows, and how long after one hides the next shows at once. */
const OPEN_DELAY_MS = 350;
const SKIP_DELAY_MS = 400;

/** Room kept between the tooltip and the window's edges, and between it and what it's about. */
const EDGE = 8;
const GAP = 6;

/** When the last tooltip hid: a tooltip shown soon after shows at once. */
let lastHidden = 0;

const layerClass = "kt-tooltip-layer kt-theme fixed top-0 left-0 z-(--kt-z-overlay) size-0";

const panelClass =
	"kt-tooltip pointer-events-none fixed box-border w-max max-w-(--kt-popover-width) rounded-control border border-border-strong bg-raised px-2.5 py-1.5 font-sans text-sm leading-normal text-fg shadow-float [overflow-wrap:anywhere]";

type Place = { readonly top: number; readonly left: number };

/** Above the anchor, centred on it, or below it where there's no room above; never off the window's sides. */
export function placeTooltip(
	anchor: { readonly top: number; readonly bottom: number; readonly left: number; readonly width: number },
	size: { readonly width: number; readonly height: number },
	view: { readonly width: number; readonly height: number },
	side: "top" | "bottom" = "top",
): Place {
	const above = anchor.top - GAP - size.height;
	const below = anchor.bottom + GAP;
	const top =
		side === "top"
			? above >= EDGE
				? above
				: below
			: below + size.height <= view.height - EDGE
				? below
				: Math.max(EDGE, above);
	const centred = anchor.left + anchor.width / 2 - size.width / 2;
	const left = Math.min(Math.max(EDGE, centred), Math.max(EDGE, view.width - size.width - EDGE));
	return { top, left };
}

export type TooltipProps = {
	/** What it says. Short: a sentence or two, or a few lines of figures. */
	content: ReactNode;
	/**
	 * What it's about: one element, which gets `aria-describedby` while the tooltip shows. Give a focusable element (a
	 * button, a link) where a keyboard should reach it; text that's only truncated needs no focus.
	 */
	children: ReactElement<{ "aria-describedby"?: string }>;
	/** Where it opens: above (default), or below. It moves to the other side where there's no room. */
	side?: "top" | "bottom";
	/** Shown at once and kept, for a story or a test. */
	defaultOpen?: boolean;
	/** No tooltip: the element alone, as when the text it would repeat isn't truncated. */
	disabled?: boolean;
	/**
	 * Only while its child is cut short (wider than its box, as `truncate` cuts it): for a tooltip that repeats text
	 * in full. Measured each time it would show, so it follows the column's width.
	 */
	whenTruncated?: boolean;
	className?: string;
};

/** Whether an element, or the element inside it that holds its text, is cut short. */
const cutShort = (element: Element | null): boolean => {
	for (let at: Element | null = element; at !== null; at = at.firstElementChild)
		if (at instanceof HTMLElement && at.scrollWidth > at.clientWidth + 1) return true;
	return false;
};

/**
 * A tooltip on hover and focus. Wraps its one child in an inline span that listens for the pointer and focus, so the
 * child keeps its own handlers. Not for anything someone must act on (it can't hold a button) or must read to use the
 * page: say that in the page.
 */
export function Tooltip({
	content,
	children,
	side = "top",
	defaultOpen = false,
	disabled = false,
	whenTruncated = false,
	className,
}: TooltipProps) {
	const [open, setOpen] = useState(defaultOpen);
	const [place, setPlace] = useState<Place>();
	const anchor = useRef<HTMLSpanElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const id = useId();

	const hide = useCallback(() => {
		clearTimeout(timer.current);
		timer.current = undefined;
		setOpen((current) => {
			if (current) lastHidden = Date.now();
			return defaultOpen;
		});
		setPlace(undefined);
	}, [defaultOpen]);

	const show = useCallback(
		(now: boolean) => {
			if (disabled) return;
			if (whenTruncated && !cutShort(anchor.current?.firstElementChild ?? null)) return;
			clearTimeout(timer.current);
			if (now || Date.now() - lastHidden < SKIP_DELAY_MS) {
				setOpen(true);
				return;
			}
			timer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
		},
		[disabled, whenTruncated],
	);

	useEffect(() => () => clearTimeout(timer.current), []);
	useEffect(() => {
		if (disabled) hide();
	}, [disabled, hide]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: new content has a new size, so it's placed again.
	useLayoutEffect(() => {
		if (!open || anchor.current === null || panel.current === null) return;
		const box = anchor.current.getBoundingClientRect();
		const size = panel.current.getBoundingClientRect();
		setPlace(placeTooltip(box, size, { width: window.innerWidth, height: window.innerHeight }, side));
	}, [open, side, content]);

	// Escape hides it; a scroll moves what it points at, so it hides then too.
	useEffect(() => {
		if (!open || defaultOpen) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") hide();
		};
		document.addEventListener("keydown", onKey, true);
		document.addEventListener("scroll", hide, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			document.removeEventListener("scroll", hide, true);
		};
	}, [open, defaultOpen, hide]);

	const child = isValidElement(children)
		? cloneElement(children, open && !disabled ? { "aria-describedby": id } : {})
		: children;
	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: it only listens for the pointer and focus of what it wraps, which is what a keyboard reaches. */}
			<span
				ref={anchor}
				className={`kt-tooltip-anchor inline-flex min-w-0 max-w-full${className === undefined ? "" : ` ${className}`}`}
				onPointerEnter={(event: PointerEvent) => {
					// A touch shows nothing: it would stay up over what was tapped.
					if (event.pointerType !== "touch") show(false);
				}}
				onPointerLeave={hide}
				onPointerDown={hide}
				onFocus={(event: FocusEvent) => {
					// Only keyboard focus: a click's focus shouldn't pop one up under the pointer that just pressed.
					if (event.target instanceof Element && event.target.matches(":focus-visible")) show(true);
				}}
				onBlur={hide}
			>
				{child}
			</span>
			{open && !disabled && typeof document !== "undefined"
				? createPortal(
						<div className={layerClass}>
							<div
								ref={panel}
								id={id}
								role="tooltip"
								className={panelClass}
								style={place === undefined ? { visibility: "hidden" } : { top: place.top, left: place.left }}
							>
								{content}
							</div>
						</div>,
						document.body,
					)
				: null}
		</>
	);
}

/**
 * A small "?" after a column's heading or a field's label, with what it means in a tooltip. A Tab stop of its own, so
 * a keyboard reaches the explanation too; it does nothing when pressed.
 */
export function HelpHint({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Tooltip content={children}>
			<button
				type="button"
				className="kt-help-hint kt-focusable relative z-1 inline-flex size-4 flex-none cursor-help items-center justify-center rounded-full border-0 bg-transparent p-0 text-faint hover:text-muted"
				aria-label={label}
			>
				<QuestionIcon size="sm" />
			</button>
		</Tooltip>
	);
}
