import type { ReactNode } from "react";
import {
	ENDORSED_WIDTH,
	ENDORSEMENT,
	ENDORSEMENT_INNER_TRANSFORM,
	ENDORSEMENT_TRANSFORM,
	FULCRUM,
	LOCKUP_WIDTH,
	MARK_SIZE,
	type Shape,
	TILE,
	WORDMARK,
	WORDMARK_BOX,
} from "./artwork.ts";

// Kantel's mark and wordmark, drawn inline from the approved outlines (artwork.ts), so they follow the theme: the ink is
// --kt-brand-ink (white on a dark theme, grey 900 on a light one, as the artwork's on-dark and on-light files) and the
// fulcrum --kt-brand-fulcrum, the brand's orange. The beam is knocked out of the tile, so it shows the ground behind.
//
// Never set in a font: the a, e and l are the Lleverage wordmark's own, and K, n and t are Public Sans SemiBold, drawn.
// Size one by its height (`h-(--kt-brand-sm)`); the width follows. The outlined SVG files, light and dark, are in
// ./artwork/ for anything outside React (the favicon, a README).

type BrandProps = {
	/** Classes for the <svg>: its height, and anything else. */
	readonly className?: string;
	/**
	 * Its accessible name. Leave it out where the name is said beside it, or the artwork is decoration: it is then hidden
	 * from assistive technology.
	 */
	readonly title?: string;
};

const ink = "fill-brand-ink";

function Paths({ shapes, className }: { shapes: readonly Shape[]; className: string }) {
	return shapes.map((shape, index) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of outlines that never changes; letters repeat, so no other key is unique.
		<path key={index} className={className} d={shape.d} transform={shape.transform} />
	));
}

function Mark() {
	return (
		<>
			<path className={ink} fillRule="evenodd" clipRule="evenodd" d={TILE.d} />
			<path className="fill-brand-fulcrum" d={FULCRUM.d} transform={FULCRUM.transform} />
		</>
	);
}

function Svg({
	viewBox,
	base,
	className,
	title,
	children,
}: BrandProps & { viewBox: string; base: string; children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noSvgWithoutTitle: decoration is aria-hidden; named artwork gets role="img" and a title.
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox={viewBox}
			className={`${base} block w-auto flex-none${className ? ` ${className}` : ""}`}
			{...(title === undefined ? { "aria-hidden": true, focusable: false } : { role: "img", "aria-label": title })}
		>
			{title === undefined ? null : <title>{title}</title>}
			{children}
		</svg>
	);
}

/** The mark alone: the beam on its fulcrum, on the squircle tile. For a favicon-sized place, or above a heading. */
export function KantelMark(props: BrandProps) {
	return (
		<Svg {...props} base="kt-kantel-mark" viewBox={`0 0 ${MARK_SIZE} ${MARK_SIZE}`}>
			<Mark />
		</Svg>
	);
}

/** The wordmark alone, "Kantel", for where the mark is already on screen. */
export function KantelWordmark(props: BrandProps) {
	const [x, y, width, height] = WORDMARK_BOX;
	return (
		<Svg {...props} base="kt-kantel-wordmark" viewBox={`${x} ${y} ${width} ${height}`}>
			<Paths shapes={WORDMARK} className={ink} />
		</Svg>
	);
}

/**
 * The horizontal lockup: the mark and "Kantel" on one line, as in the sidebar's head. `endorsed` adds "by Lleverage"
 * after it, the default endorsed lockup, for a page that stands on its own (sign-in).
 */
export function KantelLockup({ endorsed = false, ...props }: BrandProps & { readonly endorsed?: boolean }) {
	return (
		<Svg {...props} base="kt-kantel-lockup" viewBox={`0 0 ${endorsed ? ENDORSED_WIDTH : LOCKUP_WIDTH} ${MARK_SIZE}`}>
			<Mark />
			<Paths shapes={WORDMARK} className={ink} />
			{endorsed ? (
				<g transform={ENDORSEMENT_TRANSFORM}>
					<Paths shapes={ENDORSEMENT.slice(0, 2)} className={ink} />
					<g transform={ENDORSEMENT_INNER_TRANSFORM}>
						<Paths shapes={ENDORSEMENT.slice(2)} className={ink} />
					</g>
				</g>
			) : null}
		</Svg>
	);
}
