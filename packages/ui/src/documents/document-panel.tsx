import { X } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useId, useState } from "react";
import { IconButton } from "../primitives/button.tsx";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";
import { NoteMarkdown } from "../workspace/note-markdown.tsx";
import { ShareButton, SharePopover, type SharePopoverProps, shareAnchor } from "./share-popover.tsx";
// Only what utilities can't say: the two keyframes, and the type of the Markdown and ProseMirror HTML on the page.
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

// Styled with Tailwind utilities (src/tokens/tailwind.css), apart from document-panel.css above. hb-doc-streaming and
// the editor's hb-doc-prose are that file's hooks.

/** What's happening beside the title: writing, saving, saved. */
const statusLine = "inline-flex flex-none items-center gap-1.5 text-xs";

const SAVE_LABELS: { readonly [state in DocumentSaveState]: string } = {
	saved: "Saved",
	saving: "Saving",
	unsaved: "Edited",
	failed: "Couldn't save",
};

function Status({ status, saveState }: { status: DocumentPanelStatus; saveState: DocumentSaveState | undefined }) {
	if (status === "streaming") {
		return (
			<span className={`${statusLine} text-muted`} aria-live="polite">
				<Spinner size="sm" />
				Writing
			</span>
		);
	}
	if (status !== "ready" || saveState === undefined) return null;
	return (
		<span className={`${statusLine} ${saveState === "failed" ? "text-status-error" : "text-muted"}`} aria-live="polite">
			{saveState === "saving" ? <Spinner size="sm" /> : null}
			{SAVE_LABELS[saveState]}
		</span>
	);
}

function Loading({ title }: { title: string }) {
	return (
		<div className="flex flex-col gap-2.5 pt-8" aria-busy="true">
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
		<aside
			// Slides in from the right (hb-doc-panel-in, document-panel.css), opacity and transform only.
			className="hb-doc-panel flex h-full min-h-0 min-w-0 animate-[hb-doc-panel-in_var(--hb-duration)_var(--hb-ease)] flex-col border-l border-border bg-canvas text-fg motion-reduce:animate-none"
			aria-labelledby={id}
			data-status={status}
		>
			<header className="flex min-h-control-lg flex-none items-center gap-2.5 border-b border-border py-2 pr-2.5 pl-4">
				<h2 id={id} className="m-0 min-w-0 truncate text-md leading-tight font-medium" title={title}>
					{title}
				</h2>
				<Status status={status} saveState={saveState} />
				<div className="ml-auto flex flex-none items-center gap-1">
					{actions}
					{share === undefined || status === "streaming" ? null : (
						<span className={shareAnchor}>
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
			<section
				// The focus ring inset, so the panel's edges don't clip it. `!`: base.css's .hb-focusable offset is unlayered.
				className="hb-focusable min-h-0 flex-auto overflow-auto overscroll-contain focus-visible:-outline-offset-(--hb-ring)!"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable to scroll by keyboard.
				tabIndex={0}
				aria-label={`Contents of ${title}`}
			>
				<div className="mx-auto w-full max-w-doc px-6 pb-12 [&>.hb-notice]:mt-6" ref={pageRef}>
					{status === "loading" ? (
						<Loading title={title} />
					) : status === "error" ? (
						<Notice level="error">{error ?? `${title} couldn't be read.`}</Notice>
					) : status === "streaming" ? (
						<div className="hb-doc-streaming relative">
							<NoteMarkdown text={markdown} />
							<span
								// The caret after the text that's arriving: it breathes (hb-doc-caret, document-panel.css), opacity only.
								className="mt-1 inline-block h-(--hb-doc-text) w-1 animate-[hb-doc-caret_var(--hb-duration-pulse)_var(--hb-ease-breathe)_infinite] rounded-xs bg-accent-text motion-reduce:animate-none"
								aria-hidden="true"
							/>
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
