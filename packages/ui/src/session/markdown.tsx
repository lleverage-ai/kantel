import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./markdown.css";

// Incremental Markdown. A streamed answer only ever grows at its end, so the text is split into top-level blocks at
// blank lines outside code fences, and each block is its own memoised component keyed by position: when a token
// arrives, every completed block keeps its props and is neither parsed nor rendered again; only the last, open block
// is. T3 Code caches the parsed prefix of a document up to its last closed fence for the same reason; this does it at
// block level with React's memo instead.
//
// Trade-off: a construct that spans blank lines (a loose list, a reference link defined later) is parsed per block.
// Lists still render as lists, numbered ones keep their start number; reference links are rare in agent output.

const plugins = [remarkGfm];

// Links leave the session in a new tab, so following one never loses the reader's place in the transcript.
const components: Components = {
	a: ({ node: _node, ...props }) => <a {...props} className="hb-focusable" target="_blank" rel="noreferrer noopener" />,
};

/** Split Markdown into top-level blocks. A block ends at a blank line outside a fenced code block. */
export function splitBlocks(text: string): string[] {
	const blocks: string[] = [];
	let start = 0;
	let fence: string | undefined;
	let position = 0;
	while (position <= text.length) {
		const end = text.indexOf("\n", position);
		const lineEnd = end === -1 ? text.length : end;
		const line = text.slice(position, lineEnd);
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker !== undefined) {
			if (fence === undefined) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
		} else if (fence === undefined && line.trim() === "" && lineEnd > start) {
			const block = text.slice(start, position);
			if (block.trim() !== "") blocks.push(block);
			start = lineEnd + 1;
		}
		if (end === -1) break;
		position = end + 1;
	}
	const rest = text.slice(start);
	if (rest.trim() !== "") blocks.push(rest);
	return blocks;
}

const Block = memo(function Block({ text }: { text: string }) {
	return (
		<ReactMarkdown remarkPlugins={plugins} components={components} skipHtml>
			{text}
		</ReactMarkdown>
	);
});

/**
 * Renders Markdown (GitHub flavoured, raw HTML skipped) for the transcript. Re-parses only the last block as text
 * streams in.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
	const blocks = useMemo(() => splitBlocks(text), [text]);
	return (
		<div className={`hb-markdown${className ? ` ${className}` : ""}`}>
			{blocks.map((block, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional; only the last one changes while text streams.
				<Block key={index} text={block} />
			))}
		</div>
	);
}
