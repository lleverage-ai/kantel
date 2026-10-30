// What the file browser shows for one file, worked out from what the workspace read API answered: the pure part of
// the files screen, so it can be tested without a page. The file opens in the same preview as everywhere else in the
// console (@harbour/ui's FilePreview); this says what it has of the file.

import {
	entryName,
	type PreviewContent,
	type PreviewFile,
	rendererFor,
	sortEntries,
	type WorkspaceEntry,
} from "@harbour/ui";
import type { WorkspaceFile } from "../api/client.ts";

/** The read API's content limit; a bigger file is shown as too large without being asked for. */
export const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

/** A file read: in flight, failed, or its bytes. */
export type FileRead =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly code: string; readonly message: string }
	| { readonly status: "ready"; readonly file: WorkspaceFile };

/** Whether a name has an extension the preview knows as a binary it can't draw: an archive, an executable. */
const KNOWN_BINARY = /\.(zip|gz|tgz|tar|7z|rar|bz2|xz|zst|jar|war|exe|dll|so|dylib|bin|dmg|iso|wasm|o|a|class|pyc)$/i;

/**
 * Whether to read a file at all. One the listing says is over the API's limit, or an archive or other binary the
 * preview can't draw, is shown as such without fetching its bytes.
 */
export function shouldRead(path: string, entry: WorkspaceEntry | undefined): boolean {
	if (KNOWN_BINARY.test(path)) return false;
	return entry === undefined || entry.size <= MAX_CONTENT_BYTES;
}

/** A workspace file as the preview shows it: its path is its key. */
export function previewOfPath(path: string, entry: WorkspaceEntry | undefined): PreviewFile {
	return { key: path, name: entryName(path), path, ...(entry === undefined ? {} : { size: entry.size }) };
}

/** What the preview has of `path`: from its listing entry (when listed) and the read, if one was made. */
export function contentOf(path: string, entry: WorkspaceEntry | undefined, read: FileRead | undefined): PreviewContent {
	if (read === undefined) {
		if (entry !== undefined && entry.size > MAX_CONTENT_BYTES) return { status: "too-large" };
		// Not read: an archive, shown as a file to download, from what its name says.
		if (!shouldRead(path, entry)) return { status: "ready", bytes: new Uint8Array(), contentType: "" };
		return { status: "loading" };
	}
	switch (read.status) {
		case "loading":
			return read;
		case "error":
			return read.code === "too_large" ? { status: "too-large" } : { status: "error", message: read.message };
		case "ready":
			return { status: "ready", bytes: read.file.content, contentType: mediaType(read.file.contentType) };
	}
}

/** The files beside `path` in its directory, in the tree's order: Previous and Next in the preview. */
export function siblingsOf(entries: readonly WorkspaceEntry[] | undefined): readonly PreviewFile[] {
	if (entries === undefined) return [];
	return sortEntries(entries)
		.filter((entry) => entry.kind === "file")
		.map((entry) => previewOfPath(entry.path, entry));
}

/** Whether the preview draws this file from its bytes, so reading it ahead (Previous, Next) is worth it. */
export function worthPrefetching(entry: WorkspaceEntry): boolean {
	return (
		shouldRead(entry.path, entry) &&
		entry.size <= 2 * 1024 * 1024 &&
		rendererFor(previewOfPath(entry.path, entry)).kind !== "binary"
	);
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
