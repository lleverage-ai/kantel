// The pure part of documents: what a document's file is called, and the draft a transcript is streaming.

import type { DraftDocument, TranscriptItem } from "@kantel/protocol";

/** A file name for a title: lower case, words joined by hyphens, nothing but letters, digits and hyphens. */
export function documentSlug(title: string): string {
	const slug = title
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64)
		.replace(/-+$/, "");
	return slug === "" ? "document" : slug;
}

/** The document the newest answer is still writing (`create_document` streaming in), if it is writing one. */
export function draftDocument(items: readonly TranscriptItem[]): DraftDocument | undefined {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind !== "assistant") continue;
		return item.streaming ? item.document : undefined;
	}
	return undefined;
}
