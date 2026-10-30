import type { DraftDocument, PresentedFile } from "@harbour/protocol";
import {
	DocumentPanel,
	type DocumentPanelStatus,
	type DocumentSaveState,
	exportMarkdown,
	printDocument,
	type ShareExport,
} from "@harbour/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFile, WrittenFile } from "../api/client.ts";
import { ApiError } from "../api/http.ts";

// A document the agent wrote (`create_document`) in the session screen's right-hand panel. While the answer streams,
// the draft from the transcript fills the page; once the call has saved it, the file is read through the workspace
// read API and the person edits it in place, saved back a moment after they stop typing, only if the agent hasn't
// changed the file meanwhile.

/** How long after the last keystroke an edit is saved. */
const SAVE_AFTER_MS = 800;

/** The Export tab's options for a document: Markdown and PDF. */
function useExports(title: string, markdown: () => string, page: () => HTMLElement | null): ShareExport[] {
	return useMemo(
		() => [
			{
				id: "markdown",
				label: "Markdown",
				hint: "A .md file of the document",
				run: () => exportMarkdown(title, markdown()),
			},
			{
				id: "pdf",
				label: "PDF",
				hint: "Print it, or save it as a PDF",
				run: () => {
					const element = page();
					if (element !== null) printDocument(title, element);
				},
			},
		],
		[title, markdown, page],
	);
}

/** The draft streaming in: read-only, with no Share until it's saved. */
export function DraftDocumentView({ draft, onClose }: { draft: DraftDocument; onClose: () => void }) {
	return <DocumentPanel title={draft.title} markdown={draft.text} status="streaming" onClose={onClose} />;
}

/** A saved document: read, then edited in place and saved back. */
export function DocumentView({
	file,
	read,
	write,
	onClose,
	initialText,
}: {
	file: PresentedFile;
	read: (file: PresentedFile, signal: AbortSignal) => Promise<WorkspaceFile>;
	write: ((file: PresentedFile, markdown: string, ifMatch: string | undefined) => Promise<WrittenFile>) | undefined;
	onClose: () => void;
	/** What to show while it's read: the draft that just finished streaming, so the page doesn't blink. */
	initialText?: string | undefined;
}) {
	const title = file.title ?? file.name.replace(/\.[^.]+$/, "");
	const [status, setStatus] = useState<DocumentPanelStatus>("loading");
	const [error, setError] = useState<string>();
	const [markdown, setMarkdown] = useState(initialText ?? "");
	const [saveState, setSaveState] = useState<DocumentSaveState>("saved");
	// What the file holds as far as this panel knows: its digest (for If-Match) and its text.
	const digest = useRef<string | undefined>(undefined);
	const latest = useRef(markdown);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const saving = useRef<Promise<void>>(Promise.resolve());
	const page = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const abort = new AbortController();
		read(file, abort.signal).then(
			(read) => {
				if (abort.signal.aborted) return;
				const text = new TextDecoder().decode(read.content);
				digest.current = read.digest;
				latest.current = text;
				setMarkdown(text);
				setStatus("ready");
			},
			(reason: unknown) => {
				if (abort.signal.aborted) return;
				setStatus("error");
				setError(
					reason instanceof ApiError && reason.code === "not_found"
						? `${title} is no longer in the workspace.`
						: `${title} couldn't be read: ${reason instanceof Error ? reason.message : String(reason)}`,
				);
			},
		);
		return () => abort.abort();
	}, [file, read, title]);

	const save = useCallback(() => {
		if (write === undefined) return;
		const text = latest.current;
		saving.current = saving.current.then(async () => {
			setSaveState("saving");
			try {
				const written = await write(file, text, digest.current);
				digest.current = written.digest;
				setSaveState(latest.current === text ? "saved" : "unsaved");
			} catch {
				// A conflict (the agent changed the file meanwhile) or a failed request: the edits stay on the page, and the
				// next one tries again.
				setSaveState("failed");
			}
		});
	}, [file, write]);

	// Save what's pending when the panel closes or another document takes it.
	useEffect(
		() => () => {
			if (timer.current !== undefined) {
				clearTimeout(timer.current);
				save();
			}
		},
		[save],
	);

	const onChange = useCallback(
		(next: string) => {
			latest.current = next;
			setSaveState("unsaved");
			clearTimeout(timer.current);
			timer.current = setTimeout(() => {
				timer.current = undefined;
				save();
			}, SAVE_AFTER_MS);
		},
		[save],
	);

	const exports = useExports(
		title,
		useCallback(() => latest.current, []),
		useCallback(() => page.current, []),
	);
	const setPage = useCallback((element: HTMLDivElement | null) => {
		page.current = element;
	}, []);

	return (
		<DocumentPanel
			title={title}
			markdown={markdown}
			status={status === "loading" && initialText !== undefined ? "ready" : status}
			error={error}
			{...(write === undefined || status !== "ready" ? {} : { onChange, saveState })}
			onClose={onClose}
			share={{ exports }}
			pageRef={setPage}
		/>
	);
}
