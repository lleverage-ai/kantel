// The pure part of the file preview: what a previewed file is, which renderer shows it, and the small helpers the
// panel and its hosts share. No React here, so it can be tested without a page.

/**
 * A file as the preview shows it, wherever it came from: a presented file, a document the agent is writing, a file
 * sent with a message, or a file opened from the workspace browser. The host maps its own record onto this.
 */
export type PreviewFile = {
	/** Stable across opens: the same key is the same file, so its content comes from the host's cache. */
	readonly key: string;
	/** Its file name: "report.pdf". */
	readonly name: string;
	/** Its path, shown as the breadcrumb: "out/report.pdf", "/project/README.md". */
	readonly path: string;
	/** Its media type when known: "application/pdf". The name decides first. */
	readonly mimeType?: string | undefined;
	/** Its size in bytes, when known before the bytes are here. */
	readonly size?: number | undefined;
	/** When it last changed, as epoch milliseconds or an ISO string. */
	readonly modified?: number | string | undefined;
	/** A title to show rather than the name: a document's. */
	readonly title?: string | undefined;
	/** The model that made it, for a generated image. */
	readonly model?: string | undefined;
	/** A document the agent wrote: it opens editable, as Claude Docs does. */
	readonly document?: boolean | undefined;
};

/** What the host has of the file's content. */
export type PreviewContent =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string }
	| { readonly status: "too-large" }
	/** Text still being written (a document streaming in): shown as it arrives, with a caret after it. */
	| { readonly status: "streaming"; readonly text: string }
	| {
			readonly status: "ready";
			readonly bytes: Uint8Array;
			/** The type the server answered with, when it said; else the file's own. */
			readonly contentType?: string | undefined;
			/**
			 * An object URL the host already has for these bytes (an image's card, which has drawn it): shown as it is, so
			 * opening the image reads and decodes nothing new. The host owns it; the preview never revokes it.
			 */
			readonly url?: string | undefined;
	  };

/** Every renderer the registry has, by id. */
export type PreviewKind =
	| "markdown"
	| "code"
	| "json"
	| "csv"
	| "image"
	| "pdf"
	| "html"
	| "audio"
	| "video"
	| "docx"
	| "xlsx"
	| "pptx"
	| "binary";

/** How a renderer is matched: by extension (lower case, no dot), by media type, or by a media type's prefix. */
export type PreviewMatch = {
	readonly extensions?: readonly string[];
	readonly names?: readonly string[];
	readonly types?: readonly string[];
	readonly typePrefixes?: readonly string[];
};

/** The lower-case extension of a file name, "" when it has none ("Makefile", ".gitignore"). */
export function extensionOf(name: string): string {
	const base = name.split("/").pop() ?? name;
	const dot = base.lastIndexOf(".");
	return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** "image/png" from "image/png; charset=binary", lower case. */
export function mediaTypeOf(type: string | undefined): string {
	return (type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * The first entry whose match fits the file: by its name first (what the agent called it), then its media type, then a
 * type prefix. `fallback` when none does.
 */
export function matchKind<K extends string>(
	entries: readonly { readonly kind: K; readonly match: PreviewMatch }[],
	file: { readonly name: string; readonly mimeType?: string | undefined },
	fallback: K,
	contentType?: string,
): K {
	const extension = extensionOf(file.name);
	const base = (file.name.split("/").pop() ?? file.name).toLowerCase();
	for (const entry of entries) if (entry.match.names?.includes(base)) return entry.kind;
	if (extension !== "") for (const entry of entries) if (entry.match.extensions?.includes(extension)) return entry.kind;
	for (const type of [mediaTypeOf(file.mimeType), mediaTypeOf(contentType)]) {
		if (type === "") continue;
		for (const entry of entries) if (entry.match.types?.includes(type)) return entry.kind;
		for (const entry of entries)
			if (entry.match.typePrefixes?.some((prefix) => type.startsWith(prefix))) return entry.kind;
	}
	return fallback;
}

/** A file's title: the one it was given, or its name. */
export function previewTitle(file: Pick<PreviewFile, "name" | "title">): string {
	return file.title !== undefined && file.title.trim() !== "" ? file.title.trim() : file.name;
}

/** The folders above the file, for its breadcrumb: ["out", "charts"] for "out/charts/a.png". */
export function breadcrumbOf(path: string): readonly string[] {
	const parts = path.split("/").filter((part) => part !== "");
	return parts.slice(0, -1);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The bytes as text, or undefined when they aren't UTF-8 text (or hold a NUL, as binary files do). */
export function textOf(bytes: Uint8Array): string | undefined {
	try {
		const text = utf8.decode(bytes);
		return text.includes("\u0000") ? undefined : text;
	} catch {
		return undefined;
	}
}

/** The neighbours of `key` in `keys`, for Previous and Next, and where it is: 2 of 5. */
export function neighbours(
	keys: readonly string[],
	key: string | undefined,
): { readonly previous?: string; readonly next?: string; readonly index: number; readonly count: number } {
	const index = key === undefined ? -1 : keys.indexOf(key);
	if (index < 0) return { index: -1, count: keys.length };
	return {
		...(index > 0 ? { previous: keys[index - 1] as string } : {}),
		...(index < keys.length - 1 ? { next: keys[index + 1] as string } : {}),
		index,
		count: keys.length,
	};
}

/** The fraction of its container the panel takes, kept within bounds. */
export const PREVIEW_WIDTH = { min: 0.3, max: 0.75, initial: 0.48 } as const;

export function clampWidth(fraction: number): number {
	if (!Number.isFinite(fraction)) return PREVIEW_WIDTH.initial;
	return Math.min(PREVIEW_WIDTH.max, Math.max(PREVIEW_WIDTH.min, fraction));
}

/** Delimited text as rows of cells: RFC 4180 quoting, either line ending, a final newline ignored. */
export function parseDelimited(text: string, delimiter: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index] as string;
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					cell += '"';
					index++;
				} else quoted = false;
			} else cell += char;
			continue;
		}
		if (char === '"' && cell === "") quoted = true;
		else if (char === delimiter) {
			row.push(cell);
			cell = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[index + 1] === "\n") index++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += char;
	}
	if (cell !== "" || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}

/** The delimiter of a CSV or TSV file: a tab for .tsv or a tab-separated type, a comma otherwise. */
export function delimiterOf(file: Pick<PreviewFile, "name" | "mimeType">): string {
	return extensionOf(file.name) === "tsv" || mediaTypeOf(file.mimeType) === "text/tab-separated-values" ? "\t" : ",";
}
