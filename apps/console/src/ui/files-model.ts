// What the file browser shows for one file, worked out from what the workspace read API answered: the pure part of
// the files screen, so it can be tested without a page.

import { type FileViewState, fileKind, isNote, type NoteViewState, type WorkspaceEntry } from "@harbour/ui";
import type { WorkspaceFile } from "../api/client.ts";

/** The read API's content limit; a bigger file is shown as too large without being asked for. */
export const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

/** A file read: in flight, failed, or its bytes. */
export type FileRead =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly code: string; readonly message: string }
	| { readonly status: "ready"; readonly file: WorkspaceFile };

/** Which viewer shows the file, with its state: a note in the note viewer, anything else in the file viewer. */
export type FileView =
	| { readonly viewer: "note"; readonly state: NoteViewState }
	| { readonly viewer: "file"; readonly state: FileViewState };

/**
 * Whether to read a file at all. A file whose name says it is neither text nor an image (an archive, a binary) or that
 * the listing says is over the API's limit is shown as such without fetching its bytes.
 */
export function shouldRead(path: string, entry: WorkspaceEntry | undefined): boolean {
	if (fileKind(path) === "binary") return false;
	return entry === undefined || entry.size <= MAX_CONTENT_BYTES;
}

/** Image types every browser the console supports decodes. SVG isn't one: the read API serves it as text. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);

/** Whether the content route's type is an image the viewer shows as one. */
export function isImageType(contentType: string): boolean {
	return IMAGE_TYPES.has(mediaType(contentType).toLowerCase());
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The file's text, or undefined when its bytes aren't UTF-8 text (or hold a NUL, as binary files do). */
export function textOf(content: Uint8Array): string | undefined {
	try {
		const text = decoder.decode(content);
		return text.includes("\u0000") ? undefined : text;
	} catch {
		return undefined;
	}
}

/**
 * What the viewer shows for `path`, from its listing entry (when listed) and the read, if one was made. An image read
 * is shown from `imageSrc`, the object URL the host made from its bytes; until there is one it is still loading.
 */
export function viewOf(
	path: string,
	entry: WorkspaceEntry | undefined,
	read: FileRead | undefined,
	imageSrc?: string,
): FileView {
	const note = isNote(path);
	const size = entry?.size ?? 0;
	if (read === undefined) {
		if (entry !== undefined && entry.size > MAX_CONTENT_BYTES)
			return { viewer: "file", state: { status: "too-large", size } };
		if (!shouldRead(path, entry)) return { viewer: "file", state: { status: "binary", size } };
		return note ? { viewer: "note", state: { status: "loading" } } : { viewer: "file", state: { status: "loading" } };
	}
	switch (read.status) {
		case "loading":
			return note ? { viewer: "note", state: read } : { viewer: "file", state: read };
		case "error":
			if (read.code === "too_large") return { viewer: "file", state: { status: "too-large", size } };
			return note
				? { viewer: "note", state: { status: "error", message: read.message } }
				: { viewer: "file", state: { status: "error", message: read.message } };
		case "ready": {
			const { content, contentType, version } = read.file;
			if (isImageType(contentType)) {
				return imageSrc === undefined
					? { viewer: "file", state: { status: "loading" } }
					: {
							viewer: "file",
							state: {
								status: "image",
								src: imageSrc,
								size: content.byteLength,
								contentType: mediaType(contentType),
							},
						};
			}
			const text = textOf(content);
			if (text === undefined) {
				return {
					viewer: "file",
					state: { status: "binary", size: content.byteLength, contentType: mediaType(contentType) },
				};
			}
			if (note) return { viewer: "note", state: { status: "ready", markdown: text } };
			return { viewer: "file", state: { status: "ready", text, size: content.byteLength, version } };
		}
	}
}

/** "image/png" from "image/png; charset=binary". */
export const mediaType = (contentType: string): string => contentType.split(";")[0]?.trim() ?? contentType;

/** The listing entry for `path`, from its directory's listing, when that has been read. */
export function entryFor(entries: readonly WorkspaceEntry[] | undefined, path: string): WorkspaceEntry | undefined {
	return entries?.find((entry) => entry.path === path && entry.kind === "file");
}

/** Every directory above `path`, the root first: "", "src", "src/billing" for "src/billing/retry.ts". */
export function ancestorsOf(path: string, parent: (path: string) => string): readonly string[] {
	const chain: string[] = [];
	let current = parent(path);
	for (;;) {
		chain.unshift(current);
		if (current === "") return chain;
		const next = parent(current);
		if (next === current) return chain;
		current = next;
	}
}
