import type { ReactNode } from "react";

// The scrolling region every body that scrolls uses, so they all scroll, take focus and inset their focus ring alike.

/** A body's scrolling region: focusable, so a keyboard can scroll it, and named for what it shows. */
export function BodyScroll({
	label,
	className = "",
	children,
}: {
	label: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<section
			// The focus ring inset, so the panel's edges don't clip it. `!`: base.css's .hb-focusable offset is unlayered.
			className={`hb-focusable h-full min-h-0 overflow-auto overscroll-contain focus-visible:-outline-offset-(--hb-ring)! ${className}`}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable to scroll by keyboard.
			tabIndex={0}
			aria-label={label}
		>
			{children}
		</section>
	);
}

/** A reading page inside a body: the document measure, centred, with the panel's gutters. */
export const page = "mx-auto w-full max-w-doc px-gutter pt-6 pb-12";
