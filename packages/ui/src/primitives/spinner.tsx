// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/** The ring: a one-and-a-half hairline track with its top in the working colour, turning (hb-spin is in base.css). */
const spinnerRing =
	"inline-block flex-none border-[length:calc(var(--hb-hairline)*1.5)] border-border-strong border-t-status-working rounded-full animate-[hb-spin_var(--hb-duration-spin)_linear_infinite]";

const spinnerSizes = { sm: "size-icon-sm", md: "size-icon-md" } as const;

/** A small ring that turns while something runs. Decorative unless given a label. */
export function Spinner({ size = "md", label }: { size?: "sm" | "md"; label?: string }) {
	return (
		<span
			className={`hb-spinner hb-spinner-${size} ${spinnerRing} ${spinnerSizes[size]}`}
			{...(label === undefined ? { "aria-hidden": true } : { role: "status", "aria-label": label })}
		/>
	);
}

/**
 * A placeholder bar while content loads. Use it where the content's shape is known (a list row, a card's title);
 * use nothing at all for loads under about 300ms.
 */
/**
 * A placeholder's fill: the active ground, shimmering (hb-shimmer is in base.css). For a placeholder of another shape
 * than a line (an image's frame), with its own size; keeps the `hb-skeleton` hook.
 */
export const skeletonClass =
	"hb-skeleton block rounded-xs bg-active animate-[hb-shimmer_var(--hb-duration-shimmer)_ease-in-out_infinite]";

export function Skeleton({ width = "100%", lines = 1 }: { width?: string; lines?: number }) {
	return (
		<span className="hb-skeleton-group flex w-full flex-col gap-1.5" aria-hidden="true">
			{Array.from({ length: lines }, (_, index) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder lines.
					key={index}
					className={`${skeletonClass} h-(--hb-text-sm)`}
					style={{ width: index === lines - 1 && lines > 1 ? "60%" : width }}
				/>
			))}
		</span>
	);
}

/** A keyboard key or chord, as in "Press <Kbd>Enter</Kbd> to send". */
export function Kbd({ children }: { children: string }) {
	return (
		<kbd className="hb-kbd inline-flex h-[calc(var(--hb-control-xs)-var(--hb-step-1))] min-w-control-xs items-center justify-center rounded-xs border border-border-strong bg-raised px-1 py-0 font-sans text-2xs leading-none text-muted">
			{children}
		</kbd>
	);
}
