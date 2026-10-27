import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
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
	// A task's box is read-only and says what it means, rather than being an unnamed form control.
	input: ({ node: _node, ...props }) =>
		props.type === "checkbox" ? (
			<input {...props} disabled aria-label={props.checked === true ? "Done" : "Not done"} />
		) : (
			<input {...props} />
		),
};

/** A whole Markdown note: GitHub flavoured, raw HTML skipped, links to a new tab. Parsed once per text. */
export const NoteMarkdown = memo(function NoteMarkdown({ text }: { text: string }) {
	return (
		<div className="hb-markdown">
			<ReactMarkdown remarkPlugins={plugins} components={components} skipHtml>
				{text}
			</ReactMarkdown>
		</div>
	);
});
