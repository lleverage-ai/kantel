import { lazy, Suspense } from "react";
import { NoteMarkdown } from "../../workspace/note-markdown.tsx";
import type { PreviewBodyProps } from "../registry.ts";
import { BodyScroll, page } from "./scroll.tsx";
// The page's type (rendered Markdown and ProseMirror HTML) and the caret's keyframes: plain CSS, see the file.
import "../preview.css";

// Markdown, after Claude Docs: read as a page at the document measure; while the agent is still writing it, the text
// fills in as it arrives with a caret at its end; in Edit, the same page becomes a rich text editor (TipTap over
// Markdown). The editor is its own chunk, loaded the first time anything is edited (or warmed while the page is read),
// and until it's here the page shows as it reads, so switching to Edit doesn't jump.

const RichEditor = lazy(() => import("../../documents/rich-editor.tsx"));

/** Starts loading the editor, so Edit opens at once. */
export function warmEditor(): void {
	void import("../../documents/rich-editor.tsx").catch(() => {});
}

export default function MarkdownBody({ file, text, streaming, editing, onText, label }: PreviewBodyProps) {
	return (
		<BodyScroll label={label}>
			<div className={page}>
				{streaming ? (
					<div className="hb-doc-page relative">
						<NoteMarkdown text={text} />
						<span
							// The caret after the text that's arriving: it breathes (hb-preview-caret, preview.css), opacity only.
							className="mt-1 inline-block h-(--hb-doc-text) w-1 animate-[hb-preview-caret_var(--hb-duration-pulse)_var(--hb-ease-breathe)_infinite] rounded-xs bg-accent-text motion-reduce:animate-none"
							aria-hidden="true"
						/>
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
