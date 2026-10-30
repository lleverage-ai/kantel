import { X } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useId, useState } from "react";
import { IconButton } from "../primitives/button.tsx";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";
import { NoteMarkdown } from "../workspace/note-markdown.tsx";
import { ShareButton, SharePopover, type SharePopoverProps } from "./share-popover.tsx";
import "./document-panel.css";

// A document the agent writes, after Claude Docs: a panel at the right of the session with the document's title, Share
// and Close, then the document as a page. While the agent is still writing it the page fills in as the text arrives;
// once it's written the person edits it in place (rich text over Markdown) and the host saves it.

const RichEditor = lazy(() => import("./rich-editor.tsx"));

/** Where the document is: still being written, being read, ready, or unreadable. */
export type DocumentPanelStatus = "streaming" | "loading" | "ready" | "error";

/** Whether the person's edits are saved. */
export type DocumentSaveState = "saved" | "saving" | "unsaved" | "failed";

export type DocumentPanelProps = {
	title: string;
	/** The document as Markdown: what has arrived so far while streaming. */
	markdown: string;
	status: DocumentPanelStatus;
	/** Why it couldn't be read, with `status: "error"`. */
	error?: string | undefined;
	/** Lets the person edit it once it's ready. Without it the document is read-only. */
	onChange?: ((markdown: string) => void) | undefined;
	saveState?: DocumentSaveState | undefined;
	onClose?: (() => void) | undefined;
	/** The Share popover's sharing and exports. Without it there is no Share button. */
	share?: Omit<SharePopoverProps, "title" | "onClose"> | undefined;
	/** Called with the page's element once it shows, so a host can print or export what the person sees. */
	pageRef?: ((element: HTMLDivElement | null) => void) | undefined;
	/** Anything else for the header, before Share. */
	actions?: ReactNode;
};

const SAVE_LABELS: { readonly [state in DocumentSaveState]: string } = {
	saved: "Saved",
	saving: "Saving",
	unsaved: "Edited",
	failed: "Couldn't save",
};

function Status({ status, saveState }: { status: DocumentPanelStatus; saveState: DocumentSaveState | undefined }) {
	if (status === "streaming") {
		return (
			<span className="hb-doc-status" aria-live="polite">
				<Spinner size="sm" />
				Writing
			</span>
		);
	}
	if (status !== "ready" || saveState === undefined) return null;
	return (
		<span className={`hb-doc-status${saveState === "failed" ? " hb-doc-status-failed" : ""}`} aria-live="polite">
			{saveState === "saving" ? <Spinner size="sm" /> : null}
			{SAVE_LABELS[saveState]}
		</span>
	);
}

function Loading({ title }: { title: string }) {
	return (
		<div className="hb-doc-loading" aria-busy="true">
			<span className="hb-sr-only">Loading {title}</span>
			<Skeleton width="55%" />
			<Skeleton width="90%" />
			<Skeleton width="80%" />
			<Skeleton lines={4} />
		</div>
	);
}

/** A document in a panel: streamed in, then edited in place, with Share. Escape closes it (not while sharing). */
export function DocumentPanel({
	title,
	markdown,
	status,
	error,
	onChange,
	saveState,
	onClose,
	share,
	actions,
	pageRef,
}: DocumentPanelProps) {
	const id = useId();
	const [sharing, setSharing] = useState(false);
	useEffect(() => {
		if (onClose === undefined) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented && !sharing) onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose, sharing]);
	return (
		<aside className="hb-doc-panel" aria-labelledby={id} data-status={status}>
			<header className="hb-doc-header">
				<h2 id={id} className="hb-doc-title" title={title}>
					{title}
				</h2>
				<Status status={status} saveState={saveState} />
				<div className="hb-doc-actions">
					{actions}
					{share === undefined || status === "streaming" ? null : (
						<span className="hb-share-anchor">
							<ShareButton open={sharing} onToggle={() => setSharing((open) => !open)} />
							{sharing ? <SharePopover {...share} title={title} onClose={() => setSharing(false)} /> : null}
						</span>
					)}
					{onClose === undefined ? null : (
						<IconButton
							variant="ghost"
							label="Close the document"
							icon={<X className="hb-icon hb-icon-md" aria-hidden="true" />}
							onClick={onClose}
						/>
					)}
				</div>
			</header>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable to scroll by keyboard. */}
			<section className="hb-doc-scroll hb-focusable" tabIndex={0} aria-label={`Contents of ${title}`}>
				<div className="hb-doc-page" ref={pageRef}>
					{status === "loading" ? (
						<Loading title={title} />
					) : status === "error" ? (
						<Notice level="error">{error ?? `${title} couldn't be read.`}</Notice>
					) : status === "streaming" ? (
						<div className="hb-doc-streaming">
							<NoteMarkdown text={markdown} />
							<span className="hb-doc-caret" aria-hidden="true" />
						</div>
					) : (
						<Suspense
							fallback={
								<div className="hb-doc-prose">
									<NoteMarkdown text={markdown} />
								</div>
							}
						>
							<RichEditor
								markdown={markdown}
								editable={onChange !== undefined}
								onChange={onChange}
								label={`Edit ${title}`}
							/>
						</Suspense>
					)}
				</div>
			</section>
		</aside>
	);
}
