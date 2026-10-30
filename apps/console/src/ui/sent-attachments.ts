// The files sent with a message, above its bubble: each image's thumbnail, and a card opening its file in the panel at
// the right, where a presented file opens. Both read the file back from the project it was uploaded to
// (`SessionActions.readAttachment`).

import type { PresentedFile, UserAttachment } from "@harbour/protocol";
import type { SentAttachmentsHost } from "@harbour/ui";
import { useEffect, useMemo, useState } from "react";
import type { AttachmentContent, WorkspaceFile } from "../api/client.ts";

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
	const urls = new Map<string, Promise<string | undefined>>();
	const made: string[] = [];
	let disposed = false;
	return {
		thumbnail(attachment: UserAttachment): Promise<string | undefined> {
			let url = urls.get(attachment.id);
			if (url === undefined) {
				// Not aborted with the card: another card, or the same one after a re-render, takes the same read.
				url = read(attachment, new AbortController().signal).then(
					({ content, contentType }) => {
						if (disposed || !contentType.startsWith("image/")) return undefined;
						const objectUrl = URL.createObjectURL(
							new Blob([content as Uint8Array<ArrayBuffer>], { type: contentType }),
						);
						made.push(objectUrl);
						return objectUrl;
					},
					() => {
						urls.delete(attachment.id);
						return undefined;
					},
				);
				urls.set(attachment.id, url);
			}
			return url;
		},
		dispose() {
			disposed = true;
			for (const url of made.splice(0)) URL.revokeObjectURL(url);
			urls.clear();
		},
	};
}

type Thumbnails = ReturnType<typeof createThumbnails>;

/** The sent cards' host: thumbnails and opening, when the session can read its attachments back. */
export function useSentAttachments(
	read: Read | undefined,
	openFile: PresentedFile | undefined,
	open: (file: PresentedFile) => void,
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
						...(openId === undefined ? {} : { openId }),
					},
		[read, thumbnails, open, openId],
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
