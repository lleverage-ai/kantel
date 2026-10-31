import { lazy, Suspense } from "react";
import { useSmoothText } from "../../session/smooth-text.ts";
import { NoteMarkdown } from "../../workspace/note-markdown.tsx";
import type { PreviewBodyProps } from "../registry.ts";
import { BodyScroll, page } from "./scroll.tsx";
// The page's type (rendered Markdown and ProseMirror HTML) and the caret's keyframes: plain CSS, see the file.
import "../preview.css";

// Markdown, after Claude Docs: read as a page at the document measure; while the agent is still writing it, the text
// flows in as it arrives with a caret at the end of its last line; in Edit, the same page becomes a rich text editor (TipTap over
// Markdown). The editor is its own chunk, loaded the first time anything is edited (or warmed while the page is read),
// and until it's here the page shows as it reads, so switching to Edit doesn't jump.

const RichEditor = lazy(() => import("../../documents/rich-editor.tsx"));

/** Starts loading the editor, so Edit opens at once. */
export function warmEditor(): void {
	void import("../../documents/rich-editor.tsx").catch(() => {});
}

export default function MarkdownBody({ file, text, streaming, editing, onText, label }: PreviewBodyProps) {
	// The page flows in at a steady pace, as the transcript's answers do (smooth-text.ts), and stays the streaming page
	// until what arrived has drained. A whole document re-parses on each render, so at most one every 48ms.
	const shown = useSmoothText(text, streaming, 48);
	const flowing = streaming || shown.length < text.length;
	return (
		<BodyScroll label={label}>
			<div className={page}>
				{flowing ? (
					// The caret sits at the end of the last line of text, breathing (hb-doc-streaming, preview.css).
					<div className="hb-doc-page hb-doc-streaming">
						<NoteMarkdown text={shown} />
					</div>
				) : editing ? (
					<Suspense
						fallback={
							<div className="hb-doc-page">
								<NoteMarkdown text={text} />
							</div>
						}
					>
						<RichEditor markdown={text} editable onChange={onText} label={`Edit ${file.name}`} />
					</Suspense>
				) : (
					<div className="hb-doc-page">
						<NoteMarkdown text={text} />
					</div>
				)}
			</div>
		</BodyScroll>
	);
}
