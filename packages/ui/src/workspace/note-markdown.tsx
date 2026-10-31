import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownTable } from "../session/markdown-table.tsx";
import { foldComponents, rehypeSections } from "./note-sections.tsx";
import "../session/markdown.css";

// A note is a whole document, not a streamed answer, so it is parsed in one piece: a reference link defined further
// down resolves, and a task list inside a quote or a list is still a task list. The transcript's `Markdown` splits
// at blank lines so that streaming re-parses only the last block, which a stored note doesn't need. The look is the
// transcript's (the same `hb-markdown` styles); what differs is for a reader with a keyboard or a screen reader.

const plugins = [remarkGfm];

const components: Components = {
	// Links leave the workspace in a new tab, as in the transcript.
	a: ({ node: _node, ...props }) => <a {...props} className="hb-focusable" target="_blank" rel="noreferrer noopener" />,
	// Code blocks scroll sideways rather than wrap, so they take focus for keyboard scrolling.
	pre: ({ node: _node, ...props }) => (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling code block must be reachable to scroll by keyboard.
		<pre {...props} className="hb-focusable" tabIndex={0} />
	),
	// Tables as the transcript sets them: as wide as the prose, scrolling sideways in their own box when too wide.
	table: MarkdownTable,
	// A task's box is read-only and says what it means, rather than being an unnamed form control.
	input: ({ node: _node, ...props }) =>
		props.type === "checkbox" ? (
			<input {...props} disabled aria-label={props.checked === true ? "Done" : "Not done"} />
		) : (
			<input {...props} />
		),
};

const foldingComponents: Components = { ...components, ...foldComponents };
const foldingPlugins = [rehypeSections];

/**
 * A whole Markdown note: GitHub flavoured, raw HTML skipped, links to a new tab. Parsed once per text. `foldable`:
 * its sections fold under their headings, as in Notion (note-sections.tsx).
 */
export const NoteMarkdown = memo(function NoteMarkdown({
	text,
	foldable = false,
}: {
	text: string;
	foldable?: boolean;
}) {
	return (
		<div className="hb-markdown">
			<ReactMarkdown
				remarkPlugins={plugins}
				rehypePlugins={foldable ? foldingPlugins : undefined}
				components={foldable ? foldingComponents : components}
				skipHtml
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});
