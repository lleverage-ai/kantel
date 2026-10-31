import type { ComponentProps } from "react";

/**
 * A rendered Markdown table as Claude sets one: as wide as the prose, its cells wrapping, in a box that scrolls
 * sideways only when the columns can't fit. The box takes focus so a keyboard can scroll it. markdown.css styles both;
 * the transcript's `Markdown` and the workspace's `NoteMarkdown` both render tables through it.
 */
export function MarkdownTable({ node: _node, ...props }: ComponentProps<"table"> & { node?: unknown }) {
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling table must be reachable to scroll by keyboard.
		<div className="kt-markdown-table kt-focusable" tabIndex={0}>
			<table {...props} />
		</div>
	);
}
