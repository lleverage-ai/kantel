import { type ReactNode, useId } from "react";
import { Skeleton } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { RelativeTime } from "../primitives/time.tsx";
import { Markdown } from "../session/markdown.tsx";
import { ViewerHeader, ViewerScroll } from "./viewer-header.tsx";
import { noteTitle, plainTaskMarks } from "./workspace-model.ts";
import "./note-viewer.css";

/** What the host has for the note: its Markdown, or why there is none to show. */
export type NoteViewState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string }
	| { readonly status: "ready"; readonly markdown: string; readonly updatedAt?: number };

export type NoteViewerProps = {
	/** The note's path in the workspace: "notes/release-notes.md". Its name, without the extension, is the title. */
	path: string;
	state: NoteViewState;
	/** Shows a Back button at the left, for a note opened from the tree on a phone. */
	onBack?: (() => void) | undefined;
	/** Buttons at the right end of the header: Copy, view the source as text, the note's history. */
	actions?: ReactNode;
};

const skeletonWidths = ["92%", "84%", "88%", "52%"];

function NoteBody({ title, state }: { title: string; state: NoteViewState }) {
	switch (state.status) {
		case "loading":
			return (
				<div className="hb-note-viewer-loading" aria-busy="true">
					<span className="hb-sr-only">Loading the note</span>
					<span className="hb-note-viewer-skeleton-heading">
						<Skeleton width="40%" />
					</span>
					{skeletonWidths.map((width) => (
						<Skeleton key={width} width={width} />
					))}
					<Skeleton lines={3} />
				</div>
			);
		case "error":
			return (
				<div className="hb-note-viewer-message">
					<Notice level="error">{state.message}</Notice>
				</div>
			);
		case "ready":
			return state.markdown.trim() === "" ? (
				<EmptyState title="This note is empty" />
			) : (
				<ViewerScroll label={`Contents of ${title}`} className="hb-note-viewer-scroll">
					<div className="hb-note-viewer-measure">
						<Markdown text={plainTaskMarks(state.markdown)} />
					</div>
				</ViewerScroll>
			);
	}
}

/**
 * A Markdown note, read-only, at a readable measure: a header with the note's title (its file name), its folder and
 * when it was last updated, then the rendered note, scrolling within the viewer. Rendered by the transcript's
 * Markdown component (GitHub flavoured, raw HTML skipped, links open in a new tab). Presentational: the host reads
 * the note through the workspace read API and passes its state.
 */
export function NoteViewer({ path, state, onBack, actions }: NoteViewerProps) {
	const id = useId();
	const title = noteTitle(path);
	const updated =
		state.status === "ready" && state.updatedAt !== undefined ? (
			<span>
				Updated <RelativeTime at={state.updatedAt} />
			</span>
		) : undefined;
	return (
		<article className="hb-note-viewer" aria-labelledby={id}>
			<ViewerHeader id={id} path={path} title={title} facts={updated} onBack={onBack} actions={actions} />
			<div className="hb-note-viewer-body">
				<NoteBody title={title} state={state} />
			</div>
		</article>
	);
}
