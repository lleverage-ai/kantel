import type { DraftDocument, PresentedFile } from "@harbour/protocol";
import {
	exportMarkdown,
	FilePreview,
	type PreviewContent,
	type PreviewFile,
	presentedKey,
	presentedTitle,
	printDocument,
	type ShareExport,
	saveFile,
} from "@harbour/ui";
import { useCallback, useMemo, useRef } from "react";
import type { WorkspaceShares, WrittenFile } from "../api/client.ts";
import { type PreviewCache, usePreviewContent } from "./preview-cache.ts";
import { type Sharer, useFileShare } from "./use-file-share.ts";

// The session screen's file preview: every file the session opens (a presented file, a document the agent is writing
// or wrote, a file sent with a message) in the one panel at the right. It stays mounted while files change, so moving
// between them swaps the body without the panel sliding again. Bytes come from the session's preview cache, read
// through the workspace read API with the console's own credentials; edits are written back the same way, only if the
// file hasn't changed since it was read.

const encoder = new TextEncoder();

/** A presented file as the preview shows it. */
export function previewOf(file: PresentedFile): PreviewFile {
	return {
		key: presentedKey(file),
		name: file.name,
		path: file.path,
		mimeType: file.mimeType,
		size: file.size,
		title: file.title,
		model: file.model,
		document: file.document,
	};
}

/** The draft the agent is writing, as the preview shows it: a document with no path yet. */
function draftPreview(draft: DraftDocument): PreviewFile {
	return { key: `draft:${draft.callId}`, name: `${draft.title}.md`, path: "", title: draft.title, document: true };
}

export function SessionPreview({
	file,
	draft,
	lastDraft,
	siblings,
	cache,
	write,
	sharesOf,
	sharer,
	onClose,
	onNavigate,
	onReveal,
	className,
}: {
	/** The file open, if any. */
	file: PresentedFile | undefined;
	/** A document being written: shown, streaming, in place of `file`. */
	draft: DraftDocument | undefined;
	/** The draft that just finished, shown while its saved file is read, so the page doesn't blink. */
	lastDraft: DraftDocument | undefined;
	/** The session's presented files, in order, for Previous and Next. */
	siblings: readonly PresentedFile[];
	cache: PreviewCache<PresentedFile> | undefined;
	/** Writes a file back; absent where the file can't be written (a sent attachment, a read-only console). */
	write: ((file: PresentedFile, text: string, ifMatch: string | undefined) => Promise<WrittenFile>) | undefined;
	sharesOf?: ((file: PresentedFile) => Promise<WorkspaceShares | undefined>) | undefined;
	sharer?: Sharer | undefined;
	onClose: () => void;
	onNavigate: (file: PresentedFile) => void;
	/** Shows the file in the workspace browser. */
	onReveal?: ((file: PresentedFile) => void) | undefined;
	className?: string;
}) {
	const shownFile = draft === undefined ? file : undefined;
	const read = usePreviewContent(cache, shownFile);
	const preview = useMemo(
		() => (draft !== undefined ? draftPreview(draft) : file === undefined ? undefined : previewOf(file)),
		[draft, file],
	);
	const fallback = lastDraft !== undefined && file?.document === true && lastDraft.title === file.title;
	const content: PreviewContent = useMemo(() => {
		if (draft !== undefined) return { status: "streaming", text: draft.text };
		// The saved document is being read: its draft's text stands in, as it is what the file holds.
		if (read.status === "loading" && fallback && lastDraft !== undefined) {
			return { status: "ready", bytes: encoder.encode(lastDraft.text), contentType: "text/markdown" };
		}
		return read;
	}, [draft, read, fallback, lastDraft]);

	const siblingPreviews = useMemo(() => siblings.map(previewOf), [siblings]);
	const byKey = useMemo(() => new Map(siblings.map((each) => [presentedKey(each), each])), [siblings]);

	const onSave = useMemo(() => {
		if (write === undefined || shownFile === undefined || cache === undefined) return undefined;
		const target = shownFile;
		return async (text: string) => {
			const before = cache.cached(target);
			const written = await write(target, text, before?.digest);
			cache.put(target, {
				content: encoder.encode(text),
				contentType: before?.contentType ?? target.mimeType,
				version: written.version,
				...(written.digest === undefined ? {} : { digest: written.digest }),
			});
		};
	}, [write, shownFile, cache]);

	const bytes = content.status === "ready" ? content : undefined;
	const download = useMemo(
		() =>
			bytes === undefined || preview === undefined
				? undefined
				: () =>
						saveFile(bytes.bytes, preview.name, bytes.contentType || preview.mimeType || "application/octet-stream"),
		[bytes, preview],
	);

	// A document's Export: Markdown and PDF (what the page shows, printed). Anything else: the file as it is.
	const page = useRef<HTMLElement | null>(null);
	const pageRef = useCallback((element: HTMLElement | null) => {
		page.current = element;
	}, []);
	const title = shownFile === undefined ? "" : presentedTitle(shownFile);
	const exports = useMemo((): ShareExport[] => {
		if (shownFile?.document === true && bytes !== undefined) {
			return [
				{
					id: "markdown",
					label: "Markdown",
					hint: "A .md file of the document",
					run: () => exportMarkdown(title, new TextDecoder().decode(bytes.bytes)),
				},
				{
					id: "pdf",
					label: "PDF",
					hint: "Print it, or save it as a PDF",
					run: () => {
						if (page.current !== null) printDocument(title, page.current);
					},
				},
			];
		}
		return download === undefined || shownFile === undefined
			? []
			: [{ id: "download", label: "Download", hint: `The file as it is, ${shownFile.name}`, run: download }];
	}, [shownFile, bytes, title, download]);
	const sharing = useFileShare(shownFile, title, sharesOf, sharer);

	return (
		<FilePreview
			file={preview}
			content={content}
			onClose={onClose}
			siblings={draft === undefined ? siblingPreviews : undefined}
			onNavigate={(next) => {
				const target = byKey.get(next.key);
				if (target !== undefined) onNavigate(target);
			}}
			onDownload={download}
			reveal={
				onReveal === undefined || shownFile === undefined
					? undefined
					: { label: "Show in the workspace", run: () => onReveal(shownFile) }
			}
			share={sharing === undefined ? undefined : { sharing, exports }}
			onSave={onSave}
			pageRef={pageRef}
			{...(className === undefined ? {} : { className })}
		/>
	);
}
