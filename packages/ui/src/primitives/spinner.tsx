import "./feedback.css";

/** A small ring that turns while something runs. Decorative unless given a label. */
export function Spinner({ size = "md", label }: { size?: "sm" | "md"; label?: string }) {
	return (
		<span
			className={`hb-spinner hb-spinner-${size}`}
			{...(label === undefined ? { "aria-hidden": true } : { role: "status", "aria-label": label })}
		/>
	);
}

/**
 * A placeholder bar while content loads. Use it where the content's shape is known (a list row, a card's title);
 * use nothing at all for loads under about 300ms.
 */
export function Skeleton({ width = "100%", lines = 1 }: { width?: string; lines?: number }) {
	return (
		<span className="hb-skeleton-group" aria-hidden="true">
			{Array.from({ length: lines }, (_, index) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder lines.
					key={index}
					className="hb-skeleton"
					style={{ width: index === lines - 1 && lines > 1 ? "60%" : width }}
				/>
			))}
		</span>
	);
}

/** A keyboard key or chord, as in "Press <Kbd>Enter</Kbd> to send". */
export function Kbd({ children }: { children: string }) {
	return <kbd className="hb-kbd">{children}</kbd>;
}
