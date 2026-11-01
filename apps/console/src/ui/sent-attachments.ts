// The files sent with a message, above its bubble: each image's thumbnail, and a card opening its file in the panel at
// the right, where a presented file opens. Both read the file back from the project it was uploaded to
// (`SessionActions.readAttachment`).

import type { PresentedFile, TranscriptItem, UserAttachment } from "@kantel/protocol";
import type { SentAttachmentsHost } from "@kantel/ui";
import { useEffect, useMemo, useState } from "react";
import type { AttachmentContent, WorkspaceFile } from "../api/client.ts";
import { createImageUrls } from "./image-urls.ts";

/** The workspace an attachment opened in the panel names: none, as it isn't in one. */
const ATTACHMENTS = "harbour:attachments";

/** An attachment as the panel opens it: a presented file whose path is the attachment's ID. */
export function attachmentAsPresented(attachment: UserAttachment): PresentedFile {
	return {
		workspaceId: ATTACHMENTS,
		path: attachment.id,
		name: attachment.name,
		mimeType: attachment.type,
		size: attachment.size,
	};
}

/**
 * Every file sent with the session's messages, as the panel opens them, each once: what a `#file=` link can name
 * beside the files the session presented. A page reloaded with an attachment open (to pick up a new build, or to sign
 * in again) opens it again from this.
 */
export function sentAttachmentFiles(items: readonly TranscriptItem[]): readonly PresentedFile[] {
	const seen = new Set<string>();
	const files: PresentedFile[] = [];
	for (const item of items) {
		if (item.kind !== "user") continue;
		for (const attachment of item.attachments ?? []) {
			if (seen.has(attachment.id)) continue;
			seen.add(attachment.id);
			files.push(attachmentAsPresented(attachment));
		}
	}
	return files;
}

/** The attachment's ID, when the file open in the panel is one. */
export function openAttachmentId(file: PresentedFile | undefined): string | undefined {
	return file?.workspaceId === ATTACHMENTS ? file.path : undefined;
}

type Read = (attachment: UserAttachment, signal: AbortSignal) => Promise<AttachmentContent>;

/**
 * The thumbnails of a session's sent images: each read once, kept as an object URL for as long as the session is
 * open, and freed when it closes. A read that fails leaves the card its icon.
 */
export function createThumbnails(read: Read) {
	const urls = createImageUrls((attachment: UserAttachment) => attachment.id, read);
	return { thumbnail: urls.url, dispose: urls.dispose };
}

type Thumbnails = ReturnType<typeof createThumbnails>;

/** The sent cards' host: thumbnails and opening, when the session can read its attachments back. */
export function useSentAttachments(
	read: Read | undefined,
	openFile: PresentedFile | undefined,
	open: (file: PresentedFile) => void,
	/** Starts reading a file into the preview's cache, from its card's hover or focus. */
	warm?: ((file: PresentedFile) => void) | undefined,
): SentAttachmentsHost {
	// Made in the effect, so the cache freed when the session closes (or React remounts) is never used again.
	const [thumbnails, setThumbnails] = useState<Thumbnails>();
	useEffect(() => {
		if (read === undefined) {
			setThumbnails(undefined);
			return;
		}
		const made = createThumbnails(read);
		setThumbnails(made);
		return () => made.dispose();
	}, [read]);
	const openId = openAttachmentId(openFile);
	return useMemo(
		(): SentAttachmentsHost =>
			read === undefined
				? {}
				: {
						...(thumbnails === undefined
							? {}
							: { thumbnail: (attachment: UserAttachment) => thumbnails.thumbnail(attachment) }),
						open: (attachment) => open(attachmentAsPresented(attachment)),
						...(warm === undefined ? {} : { warm: (attachment) => warm(attachmentAsPresented(attachment)) }),
						...(openId === undefined ? {} : { openId }),
					},
		[read, thumbnails, open, warm, openId],
	);
}

/** Reads the file open in the panel: an attachment from its project, any other through `readPresented`. */
export function readOpenFile(
	readPresented: ((file: PresentedFile, signal: AbortSignal) => Promise<WorkspaceFile>) | undefined,
	readAttachment: Read | undefined,
): ((file: PresentedFile, signal: AbortSignal) => Promise<WorkspaceFile>) | undefined {
	if (readPresented === undefined && readAttachment === undefined) return undefined;
	return async (file, signal) => {
		if (file.workspaceId === ATTACHMENTS) {
			if (readAttachment === undefined) throw new Error("This console can't read attachments");
			const { content, contentType } = await readAttachment(
				{ id: file.path, name: file.name, type: file.mimeType, size: file.size, kind: "file" },
				signal,
			);
			return { content, contentType, version: "" };
		}
		if (readPresented === undefined) throw new Error("This console can't read the workspace");
		return readPresented(file, signal);
	};
}
